ALTER TABLE my_list DROP CONSTRAINT IF EXISTS my_list_kind_check;
ALTER TABLE my_list ADD CONSTRAINT my_list_kind_check CHECK (kind IN ('movie','series','live'));
