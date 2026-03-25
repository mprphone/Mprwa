CREATE TRIGGER IF NOT EXISTS trg_customers_nif_immutable_update
BEFORE UPDATE OF nif ON customers
FOR EACH ROW
WHEN substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(OLD.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9) <> ''
  AND substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(NEW.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9) <> ''
  AND substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(OLD.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9) <> substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(NEW.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9)
BEGIN
    SELECT RAISE(ABORT, 'NIF é imutável neste sistema. Alteração bloqueada.');
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_nif_not_empty_after_set
BEFORE UPDATE OF nif ON customers
FOR EACH ROW
WHEN substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(OLD.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9) <> ''
  AND substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(NEW.nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9) = ''
BEGIN
    SELECT RAISE(ABORT, 'NIF é obrigatório e não pode ser removido.');
END;
