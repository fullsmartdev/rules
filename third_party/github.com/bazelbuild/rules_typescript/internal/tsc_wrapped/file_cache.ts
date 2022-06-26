/**
 * @license
 * Copyright 2017 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as perfTrace from './perf_trace';

export interface CacheEntry<CachedType> {
  digest: string;
  value: CachedType;
}

export interface LRUCache<CachedType> {
  getCache(key: string): CachedType|undefined;
  putCache(key: string, value: CacheEntry<CachedType>, loadTimeMs: number):
      void;
  inCache(key: string): boolean;
}

/**
 * Default cache size. Without the cache involved, our steady state size
 * after parsing is in the ~150mb range.
 */
const DEFAULT_MAX_CACHE_SIZE = 300 * (1 << 20 /* 1 MB */);

/**
 * FileCache is a trivial LRU cache for bazel outputs.
 *
 * Cache entries are keyed off by an opaque, bazel-supplied digest.
 *
 * This code uses the fact that JavaScript hash maps are linked lists - after
 * reaching the cache size limit, it deletes the oldest (first) entries. Used
 * cache entries are moved to the end of the list by deleting and re-inserting.
 */
export class FileCache<CachedType> implements LRUCache<CachedType> {
  private fileCache: {[filePath: string]: CacheEntry<CachedType>} = {};
  /**
   * FileCache does not know how to construct bazel's opaque digests. This
   * field caches the last compile run's digests, so that code below knows what
   * digest to assign to a newly loaded file.
   */
  private lastDigests: {[filePath: string]: string} = {};

  cacheStats = {
    hits: 0,
    reads: 0,
    readTimeMs: 0,
    evictions: 0,
  };

  private maxCacheSize = DEFAULT_MAX_CACHE_SIZE;

  constructor(private debug: (...msg: Array<{}>) => void) {}

  setMaxCacheSize(maxCacheSize: number) {
    if (maxCacheSize < 0) {
      throw new Error(`FileCache max size is negative: ${maxCacheSize}`);
    }
    this.debug('FileCache max size is', maxCacheSize >> 20, 'MB');
    this.maxCacheSize = maxCacheSize;
    this.maybeFreeMemory();
  }

  resetMaxCacheSize() {
    this.setMaxCacheSize(DEFAULT_MAX_CACHE_SIZE);
  }

  /**
   * Updates the cache with the given digests.
   *
   * updateCache must be called before loading files - only files that were
   * updated (with a digest) previously can be loaded.
   */
  updateCache(digests: {[filePath: string]: string}) {
    this.debug('updating digests:', digests);
    this.lastDigests = digests;
    for (const fp of Object.keys(digests)) {
      const entry = this.fileCache[fp];
      if (entry && entry.digest !== digests[fp]) {
        this.debug(
            'dropping file cache entry for', fp, 'digests', entry.digest,
            digests[fp]);
        delete this.fileCache[fp];
      }
    }
  }

  getLastDigest(filePath: string): string {
    const digest = this.lastDigests[filePath];
    if (!digest) {
      throw new Error(
          `missing input digest for ${filePath}.` +
          `(only have ${Object.keys(this.lastDigests)})`);
    }
    return digest;
  }

  getCache(filePath: string): CachedType|undefined {
    this.cacheStats.reads++;

    const entry = this.fileCache[filePath];
    let value: CachedType|undefined;
    if (!entry) {
      this.debug('Cache miss:', filePath);
    } else {
      this.debug('Cache hit:', filePath);
      this.cacheStats.hits++;
      // Move a used file to the end of the cache by deleting and re-inserting
      // it.
      delete this.fileCache[filePath];
      this.fileCache[filePath] = entry;
      value = entry.value;
    }
    this.traceStats();
    return value;
  }

  putCache(filePath: string, entry: CacheEntry<CachedType>, loadTimeMs: number):
      void {
    const dropped = this.maybeFreeMemory();
    this.fileCache[filePath] = entry;
    this.cacheStats.readTimeMs += loadTimeMs;
    this.debug('Loaded', filePath, 'dropped', dropped, 'cache entries');
  }

  /**
   * Returns true if the given filePath was reported as an input up front and
   * has a known cache digest. FileCache can only cache known files.
   */
  isKnownInput(filePath: string): boolean {
    return !!this.lastDigests[filePath];
  }

  inCache(filePath: string): boolean {
    return !!this.getCache(filePath);
  }

  resetStats() {
    this.cacheStats = {
      hits: 0,
      reads: 0,
      readTimeMs: 0,
      evictions: 0,
    };
  }

  printStats() {
    let percentage;
    if (this.cacheStats.reads === 0) {
      percentage = 100.00;  // avoid "NaN %"
    } else {
      percentage =
          (this.cacheStats.hits / this.cacheStats.reads * 100).toFixed(2);
    }
    this.debug('Cache stats:', percentage, '% hits', this.cacheStats);
  }

  traceStats() {
    // counters are rendered as stacked bar charts, so record cache
    // hits/misses rather than the 'reads' stat tracked in cacheSats
    // so the chart makes sense.
    perfTrace.counter('file cache hit rate', {
      'hits': this.cacheStats.hits,
      'misses': this.cacheStats.reads - this.cacheStats.hits,
    });
    perfTrace.counter('file cache evictions', {
      'evictions': this.cacheStats.evictions,
    });
    perfTrace.counter('file cache time', {
      'read': this.cacheStats.readTimeMs,
    });
    perfTrace.counter('file cache size', {
      'files': Object.keys(this.fileCache).length,
    });
  }

  /**
   * Returns whether the cache should free some memory.
   *
   * Defined as a property so it can be overridden in tests.
   */
  shouldFreeMemory: () => boolean = () => {
    return process.memoryUsage().heapUsed > this.maxCacheSize;
  };

  /**
   * Frees memory if required. Returns the number of dropped entries.
   */
  private maybeFreeMemory() {
    if (!this.shouldFreeMemory()) {
      return 0;
    }
    // Drop half the cache, the least recently used entry == the first entry.
    this.debug('Evicting from the cache');
    const keys = Object.keys(this.fileCache);
    const dropped = Math.round(keys.length / 2);
    for (let i = 0; i < dropped; i++) {
      delete this.fileCache[keys[i]];
    }
    this.cacheStats.evictions += dropped;
    return dropped;
  }
}

export interface FileLoader {
  loadFile(fileName: string, filePath: string, langVer: ts.ScriptTarget):
      ts.SourceFile;
  fileExists(filePath: string): boolean;
}

/**
 * Load a source file from disk, or possibly return a cached version.
 */
export class CachedFileLoader implements FileLoader {
  // TODO(alexeagle): remove unused param after usages updated:
  // angular:packages/bazel/src/ngc-wrapped/index.ts
  constructor(
      private readonly cache: FileCache<ts.SourceFile>, unused?: boolean) {}

  fileExists(filePath: string) {
    return this.cache.isKnownInput(filePath);
  }

  loadFile(fileName: string, filePath: string, langVer: ts.ScriptTarget):
      ts.SourceFile {
    let sourceFile = this.cache.getCache(filePath);
    if (!sourceFile) {
      const readStart = Date.now();
      const sourceText = fs.readFileSync(filePath, 'utf8');
      sourceFile = ts.createSourceFile(fileName, sourceText, langVer, true);
      const entry = {
        digest: this.cache.getLastDigest(filePath),
        value: sourceFile
      };
      const readEnd = Date.now();
      this.cache.putCache(filePath, entry, readEnd - readStart);
      perfTrace.snapshotMemoryUsage();
    }

    return sourceFile;
  }
}

/** Load a source file from disk. */
export class UncachedFileLoader implements FileLoader {
  fileExists(filePath: string): boolean {
    return ts.sys.fileExists(filePath);
  }

  loadFile(fileName: string, filePath: string, langVer: ts.ScriptTarget):
      ts.SourceFile {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    return ts.createSourceFile(fileName, sourceText, langVer, true);
  }
}
