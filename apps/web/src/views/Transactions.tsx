import { useState } from 'react';
import type { AppData } from '../App';
import TxnRow from '../components/TxnRow';

type Filter = 'all' | 'personal' | 'business';

const FILTERS: Array<[Filter, string]> = [
  ['all', '全部'],
  ['personal', '个人'],
  ['business', '生意'],
];

export default function Transactions({ data }: { data: AppData }) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = data.txns.filter((t) => filter === 'all' || t.tags.includes(filter));
  return (
    <>
      <div className="main-head">
        <h2>流水</h2>
        <div className="seg">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        {rows.length === 0 ? (
          <p className="muted">暂无交易</p>
        ) : (
          rows.map((t) => <TxnRow key={t.id} txn={t} data={data} deletable />)
        )}
        <p className="muted small">共 {rows.length} 笔</p>
      </div>
    </>
  );
}
