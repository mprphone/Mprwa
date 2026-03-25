CREATE INDEX IF NOT EXISTS idx_customers_nif_norm
ON customers (
    substr(
        replace(
            replace(
                replace(
                    replace(
                        replace(lower(ifnull(nif, '')), 'pt', ''),
                    ' ', ''),
                '-', ''),
            '.', ''),
        '/', ''),
    -9)
);

CREATE TRIGGER IF NOT EXISTS trg_customers_nif_unique_insert
BEFORE INSERT ON customers
FOR EACH ROW
WHEN substr(
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
BEGIN
    SELECT RAISE(ABORT, 'NIF duplicado em customers')
    WHERE EXISTS (
        SELECT 1
        FROM customers
        WHERE id <> ifnull(NEW.id, '')
          AND substr(
                replace(
                    replace(
                        replace(
                            replace(
                                replace(lower(ifnull(nif, '')), 'pt', ''),
                            ' ', ''),
                        '-', ''),
                    '.', ''),
                '/', ''),
            -9) = substr(
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
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_nif_unique_update
BEFORE UPDATE OF nif ON customers
FOR EACH ROW
WHEN substr(
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
BEGIN
    SELECT RAISE(ABORT, 'NIF duplicado em customers')
    WHERE EXISTS (
        SELECT 1
        FROM customers
        WHERE id <> ifnull(NEW.id, '')
          AND substr(
                replace(
                    replace(
                        replace(
                            replace(
                                replace(lower(ifnull(nif, '')), 'pt', ''),
                            ' ', ''),
                        '-', ''),
                    '.', ''),
                '/', ''),
            -9) = substr(
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
    );
END;
