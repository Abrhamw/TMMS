import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading, SearchField, filterItems } from '../components';

export default function DataList({
  endpoint,
  params = {},
  pageSize = 25,
  columns = [],
  searchFields,
  rowKey = (row) => row && row.id,
  onRowClick,
  renderDetail,
  filters,
  empty = 'No records found',
  searchPlaceholder = 'Search…',
}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const paramsKey = useMemo(() => JSON.stringify(params), [params]);

  useEffect(() => {
    setPage(1);
  }, [paramsKey, q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    }
    search.set('page', page);
    search.set('page_size', pageSize);
    if (q) search.set('q', q);
    api.get(`${endpoint}?${search.toString()}`)
      .then((res) => { if (alive) setData(res); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [endpoint, paramsKey, page, pageSize, q]);

  const serverPaginated = data != null && !Array.isArray(data) && Array.isArray(data.items);

  const { items, total } = useMemo(() => {
    if (data == null) return { items: [], total: 0 };
    if (serverPaginated) return { items: data.items, total: data.total ?? data.items.length };
    let rows = Array.isArray(data) ? data : [];
    if (q) {
      rows = searchFields
        ? rows.filter((row) => filterItems([searchFields(row)], q).length > 0)
        : filterItems(rows, q);
    }
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
  }, [data, serverPaginated, page, pageSize, q, searchFields]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="data-list">
      <div className="data-list-toolbar">
        <SearchField value={q} onChange={setQ} placeholder={searchPlaceholder} />
        {filters}
        <span className="muted data-list-count">{total.toLocaleString()} record{total === 1 ? '' : 's'}</span>
      </div>

      {error ? <ErrorNote error={error} /> : null}
      {loading && !data ? <Loading /> : null}

      <div className="tbl-wrap">
        <table className="data-list-table">
          <thead>
            <tr>
              {columns.map((col) => <th key={col.key}>{col.label}</th>)}
              {renderDetail ? <th aria-label="Expand" /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className={onRowClick ? 'clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key}>{col.render ? col.render(row) : row[col.key]}</td>
                ))}
                {renderDetail ? <td className="data-list-expand">{renderDetail(row)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && !items.length ? <div className="empty">{empty}</div> : null}

      {pageCount > 1 && (
        <div className="data-list-pager">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
          <span className="muted">Page {page} of {pageCount}</span>
          <button className="btn btn-sm" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Next</button>
        </div>
      )}
    </div>
  );
}
