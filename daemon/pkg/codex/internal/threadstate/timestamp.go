package threadstate

import (
	"math"
	"time"
)

// NativeTimestamp accepts native Unix seconds or item timestamps in milliseconds.
func NativeTimestamp(raw any, milliseconds bool) string {
	if value, ok := raw.(string); ok {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
		return ""
	}
	value, ok := raw.(float64)
	if !ok || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) || value > 253402300799000 {
		return ""
	}
	if milliseconds {
		value /= 1000
	}
	seconds, fraction := math.Modf(value)
	if seconds > 253402300799 {
		return ""
	}
	return time.Unix(int64(seconds), int64(fraction*float64(time.Second))).UTC().Format(time.RFC3339Nano)
}
