#!/bin/bash
set -e

# should produce named UMD modules
readonly LIBRARY_JS=$(cat $TEST_SRCDIR/build_bazel_rules_typescript/examples/some_library/library.js)
if [[ "$LIBRARY_JS" != *"define(\"some-lib/library\""* ]]; then
  echo "Expected library.js to declare named module, but was"
  echo "$A_JS"
  exit 1
fi

# should give a name to required modules
readonly BAR_JS=$(cat $TEST_SRCDIR/build_bazel_rules_typescript/examples/bar.js)
if [[ "$BAR_JS" != *"require(\"build_bazel_rules_typescript/examples/foo\")"* ]]; then
  echo "Expected bar.js to require named module foo, but was"
  echo "$BAR_JS"
  exit 1
fi

# should give a name to required modules from other compilation unit
readonly FOO_JS=$(cat $TEST_SRCDIR/build_bazel_rules_typescript/examples/bar.js)
if [[ "$FOO_JS" != *"require(\"some-lib/library\")"* ]]; then
  echo "Expected bar.js to require named module library, but was"
  echo "$FOO_JS"
  exit 1
fi

# should give a name to required generated modules without bazel-bin
if [[ "$FOO_JS" != *"require(\"build_bazel_rules_typescript/examples/generated_ts/foo\")"* ]]; then
  echo "Expected foo.js to require generated named module foo, but was"
  echo "$FOO_JS"
  exit 1
fi

# should not give a module name to external modules
if [[ "$FOO_JS" != *"require(\"typescript\")"* ]]; then
  echo "Expected foo.js to require typescript by its original name, but was"
  echo "$FOO_JS"
  exit 1
fi
