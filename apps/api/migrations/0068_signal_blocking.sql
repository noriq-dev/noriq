-- PLNR-237: request_input gains blocking: false — an agent can ask without stopping.
--
-- Whether an input_request PARKED its task/run is a fact the ANSWER path needs later (a
-- blocking answer resumes a parked run via run.resume; a non-blocking one steers a still-live
-- session, or lands as a task comment when the run has since ended). Inferring it at answer
-- time is ambiguous — a blocking signal on an unclaimed task also parks nothing — so the
-- choice is recorded on the signal. DEFAULT 1: every pre-existing signal was blocking (the
-- RUN-30 contract), and every caller that doesn't pass the new flag stays on it.
ALTER TABLE signals ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1;
