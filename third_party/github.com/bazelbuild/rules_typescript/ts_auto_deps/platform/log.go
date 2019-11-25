package platform

import "google3/base/go/log"

// Infof prints a formatted message to stdout.
func Infof(format string, v ...interface{}) {
	log.Infof(format, v...)
}

// Error prints a series of args to stderr.
func Error(args ...interface{}) {
	log.Error(args...)
}

// Fatalf prints a formatted message to stderr. Panics after printing.
func Fatalf(format string, v ...interface{}) {
	log.Fatalf(format, v...)
}
