-- RUN-33: pick the model and the reasoning effort when dispatching.
--
-- The driver seam already existed and was dead: DriverStartOptions.model was threaded all the
-- way into query({ options: { model } }), and nothing ever set it, because Run had no field to
-- set it from. These two columns are the missing half.
--
-- NO CHECK CONSTRAINT ON EITHER, and that is deliberate rather than lazy:
--
-- `model` is a vendor's name and they ship new ones constantly — a CHECK would mean a migration
-- every time a model is released, to a table that (per RUN-31) cannot be rebuilt cheaply.
--
-- `effort` is more tempting, since it maps to a closed enum today (low|medium|high|xhigh|max).
-- But that enum is the SDK's, not ours, and it has ALREADY grown once — xhigh and max are recent
-- additions. A CHECK here would make "the SDK added an effort level" into "the runs table needs
-- rebuilding", which is exactly the trap RUN-31 walked into with runs.status. The zod RunEffort
-- validates it at the edge, on the way in, where a bad value can still be reported to whoever
-- sent it; a CHECK would only turn that into a 500 at the write.
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
