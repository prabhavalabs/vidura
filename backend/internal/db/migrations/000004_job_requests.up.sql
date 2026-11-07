-- At most one unfinished job per video: asking again returns the open one.
CREATE UNIQUE INDEX jobs_one_open_per_video ON jobs (video_id) WHERE status IN ('queued', 'running');
