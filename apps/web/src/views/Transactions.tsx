import { useEffect, useState } from 'react';
import { pickExportPath, saveTextFile } from '@app/store/export';
import type { AppData } from '../App';
import TxnRow from '../components/TxnRow';
import { isDesktop } from '../db';
import { buildExportRows, exportFileName, toCsv, toMarkdown } from '../export';
import { todayISO } from '../format';

export default function Transactions({ data }: { data: AppData }) {
  const rows = data.txns;
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 切换账本时清掉上一账本残留的导出消息（组件不随账本卸载，仅 data prop 变化）。
  useEffect(() => setMsg(''), [data.book.id]);

  async function doExport(fmt: 'csv' | 'md') {
    setBusy(true);
    try {
      const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
      const exportRows = buildExportRows(rows, accountMap);
      const today = todayISO();
      const text = fmt === 'csv' ? toCsv(exportRows) : toMarkdown(exportRows, data.book.name, today);
      const name = exportFileName(data.book.name, today, fmt);
      if (isDesktop) {
        const dest = await pickExportPath(name, fmt === 'csv' ? 'CSV 表格' : 'Markdown 文档', fmt);
        if (!dest) return; // 用户取消「另存为」
        await saveTextFile(dest, text);
        setMsg(`已导出：${dest}`);
      } else {
        // 浏览器演示版：Blob 下载。桌面 WebView2 下 a[download] 不可靠，恒走上面的原生对话框分支。
        const mime = fmt === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8';
        const url = URL.createObjectURL(new Blob([text], { type: mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setMsg(`已下载：${name}`);
      }
    } catch (e) {
      setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="main-head">
        <h2>{data.book.name} · 流水</h2>
        <div className="head-actions">
          <span className="muted">共 {rows.length} 笔</span>
          {rows.length > 0 && (
            <>
              <button className="btn" disabled={busy} onClick={() => void doExport('csv')}>
                导出 CSV
              </button>
              <button className="btn" disabled={busy} onClick={() => void doExport('md')}>
                导出 Markdown
              </button>
            </>
          )}
        </div>
      </div>
      {msg && (
        <p className="muted" style={{ marginTop: -8, marginBottom: 12 }}>
          {msg}
        </p>
      )}
      <div className="card">
        {rows.length === 0 ? (
          <p className="muted">暂无交易</p>
        ) : (
          rows.map((t) => <TxnRow key={t.id} txn={t} data={data} deletable />)
        )}
      </div>
    </>
  );
}
