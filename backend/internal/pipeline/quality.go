package pipeline

import "math"

// Quality scores a transcript's timings: ordering, overlap, coverage of the
// video's runtime, and how trustworthy the source is.
type Quality struct {
	Score   int            `json:"score"`
	Label   string         `json:"label"`
	Source  string         `json:"source"`
	Metrics QualityMetrics `json:"metrics"`
}

// QualityMetrics are the measurements behind the score.
type QualityMetrics struct {
	SegmentCount         int      `json:"segmentCount"`
	OverlapCount         int      `json:"overlapCount"`
	OutOfOrderCount      int      `json:"outOfOrderCount"`
	InvalidDurationCount int      `json:"invalidDurationCount"`
	CoverageRatio        *float64 `json:"coverageRatio"`
	LargestGapMs         int64    `json:"largestGapMs"`
}

// Transcript sources, as stored on the video.
const (
	SourceCaptions = "captions"
	SourceASR      = "asr"
	SourceUploaded = "uploaded"
)

// YouTube captions are timed against the video; speech recognition is
// estimated from audio.
var sourceBaseline = map[string]float64{SourceCaptions: 100, SourceUploaded: 90, SourceASR: 85}

// AssessQuality scores segments against the video's duration (0 if unknown).
func AssessQuality(segments []Segment, durationMs int64, source string) Quality {
	m := QualityMetrics{SegmentCount: len(segments)}
	for i, cur := range segments {
		if cur.EndMs <= cur.StartMs {
			m.InvalidDurationCount++
		}
		if i+1 >= len(segments) {
			continue
		}
		next := segments[i+1]
		if cur.EndMs > next.StartMs {
			m.OverlapCount++
		}
		if next.StartMs < cur.StartMs {
			m.OutOfOrderCount++
		}
		if gap := next.StartMs - cur.EndMs; gap > m.LargestGapMs {
			m.LargestGapMs = gap
		}
	}
	if durationMs > 0 && len(segments) > 0 {
		ratio := float64(segments[len(segments)-1].EndMs-segments[0].StartMs) / float64(durationMs)
		ratio = math.Round(math.Min(1, math.Max(0, ratio))*100) / 100
		m.CoverageRatio = &ratio
	}

	score, ok := sourceBaseline[source]
	if !ok {
		score = 80
	}
	if n := float64(len(segments)); n == 0 {
		score = 0
	} else {
		score -= math.Min(30, float64(m.OverlapCount)/n*100)
		score -= math.Min(25, float64(m.OutOfOrderCount)/n*200)
		score -= math.Min(15, float64(m.InvalidDurationCount)/n*100)
		if m.CoverageRatio != nil && *m.CoverageRatio < 0.9 {
			score -= math.Min(30, (0.9-*m.CoverageRatio)*100)
		}
	}
	final := int(math.Round(math.Max(0, math.Min(100, score))))
	label := "poor"
	switch {
	case final >= 90:
		label = "excellent"
	case final >= 75:
		label = "good"
	case final >= 55:
		label = "fair"
	}
	return Quality{Score: final, Label: label, Source: source, Metrics: m}
}
