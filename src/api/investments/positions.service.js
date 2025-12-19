// File: /src/api/investments/positions.service.js
// ...imports unchanged...

export async function importCsvText(user_id, csvText) {
  const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
  if (parsed.errors?.length) throw new Error('csv_parse_error');

  const rows = parsed.data.map((r) => normalizeCsvRow(r));

  const accountName = rows[0]?.account || 'Imported CSV';
  const { data: acct, error: acctErr } = await supabase
    .from('investment_accounts')
    .upsert(
      { user_id, provider: 'csv', name: accountName, type: 'brokerage', currency: 'USD', last_synced_at: new Date().toISOString() },
      { onConflict: 'user_id,name' }
    )
    .select()
    .single();
  if (acctErr) throw acctErr;

  const byTicker = new Map();
  for (const r of rows) {
    if (!r.ticker || !r.qty) continue;
    const entry = byTicker.get(r.ticker) || { qty: 0, cost_total: 0, name: r.name };
    entry.qty += r.qty;
    if (Number.isFinite(r.cost_total)) entry.cost_total += r.cost_total;
    byTicker.set(r.ticker, entry);
    if (r.price) await upsertPrice(r.ticker);
  }

  for (const [ticker, v] of byTicker) {
    const { data: sec } = await supabase
      .from('securities')
      .upsert({ ticker, name: v.name }, { onConflict: 'ticker' })
      .select()
      .single();

    await supabase
      .from('positions')
      .upsert(
        {
          user_id,
          account_id: acct.id,
          security_id: sec.id,
          quantity: v.qty,
          cost_basis_total: v.cost_total || null,
          average_price: v.cost_total && v.qty ? v.cost_total / v.qty : null,
          cost_basis_method: 'AVG',
          as_of_date: new Date().toISOString(),
        },
        { onConflict: 'user_id,account_id,security_id' }
      );
  }

  return byTicker.size;
}

export async function upsertManualPosition(body) {
  const { user_id, account_name = 'Manual Entry', ticker, name, quantity, average_price, cost_basis_total } = body;
  if (!user_id || !ticker || !quantity) throw new Error('missing_required_fields');

  const { data: acct } = await supabase
    .from('investment_accounts')
    .upsert(
      { user_id, name: account_name, provider: 'manual', type: 'brokerage', currency: 'USD' },
      { onConflict: 'user_id,name' }
    )
    .select()
    .single();

  const { data: sec } = await supabase
    .from('securities')
    .upsert({ ticker: ticker.toUpperCase(), name: name || ticker.toUpperCase() }, { onConflict: 'ticker' })
    .select()
    .single();

  await upsertPrice(ticker.toUpperCase());

  await supabase
    .from('positions')
    .upsert(
      {
        user_id,
        account_id: acct.id,
        security_id: sec.id,
        quantity: Number(quantity),
        average_price: average_price != null ? Number(average_price) : null,
        cost_basis_total:
          cost_basis_total != null
            ? Number(cost_basis_total)
            : average_price != null
            ? Number(average_price) * Number(quantity)
            : null,
        as_of_date: new Date().toISOString(),
        cost_basis_method: 'MANUAL',
      },
      { onConflict: 'user_id,account_id,security_id' }
    );
}
