export function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function quoteList(values) {
  return values.map(quote).join(", ");
}

const WRITE_KEYWORDS = /\b(insert|update|delete|create|drop|alter|copy|attach|detach|install|load|pragma|call|export|import|vacuum)\b/i;

export function readOnlySql(sql) {
  const trimmed = String(sql ?? "").trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("Write a SQL query first.");
  if (trimmed.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only SELECT or WITH queries are allowed.");
  if (WRITE_KEYWORDS.test(trimmed)) throw new Error("Only read-only analytical queries are allowed.");
  return trimmed;
}

// Arrow rows with BigInt counts and epoch dates turned into plain JSON values.
export function rowsOf(table, { dates = false } = {}) {
  const dateColumns = dates
    ? table.schema.fields.filter((field) => /date|timestamp/i.test(String(field.type))).map((field) => field.name)
    : [];
  return table.toArray().map((row) => {
    const value = row.toJSON();
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "bigint") value[key] = Number(item);
      else if (dateColumns.includes(key) && item != null) value[key] = new Date(item).toISOString().slice(0, 10);
    }
    return value;
  });
}
