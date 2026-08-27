-- Confirmed monitor state is separate from raw regional results so public state
-- can debounce failures without hiding diagnostics from operators.
ALTER TABLE monitors ADD COLUMN confirmed_outcome TEXT;
