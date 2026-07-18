-- PLNR-185: request_input v2 — structured answers + multi-round threads.
-- response_json: the per-question structured answers a human gave (JSON array of
--   {question, answer}), stored beside the derived `response` text so old readers
--   (run resume frames, notices) keep working unchanged.
-- follow_up_to: threads a clarifying round to the gate it follows; NULL for round one.
ALTER TABLE signals ADD COLUMN response_json TEXT;
ALTER TABLE signals ADD COLUMN follow_up_to TEXT REFERENCES signals(id);
