import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ProductDto } from '@sbom/shared';
import { api } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorMessage, Loading } from '../components/Feedback';
import { formatCents, formatDateTime } from '../format';

function stockStatus(p: ProductDto): { label: string; tone: string } {
  if (p.madeToOrder) return { label: 'Made to order', tone: 'info' };
  if (p.inventory.available === 0) return { label: 'Out of stock', tone: 'danger' };
  if (p.inventory.lowStock) return { label: 'Low stock', tone: 'warn' };
  return { label: 'In stock', tone: 'ok' };
}

export function Inventory() {
  const products = useApi(api.products);
  const receipts = useApi(() => api.stockReceipts());
  const [params, setParams] = useSearchParams();
  // ?restock=<productId> opens the form for that product (from the Dashboard's "Reorder").
  const restockId = Number(params.get('restock')) || null;
  const [done, setDone] = useState<string>();

  const close = () => setParams({});
  const received = (message: string) => {
    setDone(message);
    close();
    products.reload();
    receipts.reload();
  };

  return (
    <>
      <h1>Inventory</h1>
      {done && (
        <p className="alert alert-ok" role="status">
          {done}
        </p>
      )}
      <section className="card">
        {products.loading && !products.data && <Loading />}
        {products.error && <ErrorMessage error={products.error} onRetry={products.reload} />}
        {products.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Price</th>
                  <th className="num">Available</th>
                  <th className="num">On hand</th>
                  <th className="num">Reserved</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Restock</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.data.map((p) => {
                  const s = stockStatus(p);
                  const open = restockId === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr className={open ? 'row-open' : ''}>
                        <td>
                          {p.name}
                          <div className="muted small">
                            <code>{p.sku}</code> · {p.description}
                          </div>
                        </td>
                        <td className="num">{formatCents(p.unitPriceCents)}</td>
                        <td className="num">
                          <b>{p.madeToOrder ? '—' : p.inventory.available}</b>
                        </td>
                        <td className="num">{p.madeToOrder ? '—' : p.inventory.onHand}</td>
                        <td className="num">{p.madeToOrder ? '—' : p.inventory.reserved}</td>
                        <td>
                          <span className={`chip chip-stock-${s.tone}`}>{s.label}</span>
                        </td>
                        <td className="actions">
                          {!p.madeToOrder && !open && (
                            <button
                              className={`btn btn-small-inline ${p.inventory.lowStock ? '' : 'btn-ghost'}`}
                              onClick={() => {
                                setDone(undefined);
                                setParams({ restock: String(p.id) });
                              }}
                            >
                              Restock
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="row-form">
                          <td colSpan={7}>
                            <RestockForm product={p} onCancel={close} onDone={received} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent restocks</h2>
        {receipts.data?.length === 0 && (
          <p className="muted">No stock received yet. Use Restock when a delivery arrives.</p>
        )}
        <ul className="list">
          {receipts.data?.map((r) => (
            <li key={r.id}>
              <span>
                +{r.quantity} × {r.productName}
                {r.note && <span className="muted"> · {r.note}</span>}
              </span>
              <span className="muted small">
                {r.onHandAfter} on hand after · {r.receivedBy} · {formatDateTime(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function RestockForm({
  product,
  onCancel,
  onDone,
}: {
  product: ProductDto;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const suggestion = product.inventory.suggestedReorder;
  const [quantity, setQuantity] = useState(String(suggestion ?? 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.scrollIntoView({ block: 'center' });
  }, []);

  const n = Number(quantity);
  const valid = Number.isInteger(n) && n > 0 && n <= 10_000;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      let receivedBy: string | undefined;
      try {
        receivedBy = localStorage.getItem('sbom.decidedBy') || undefined;
      } catch {
        receivedBy = undefined;
      }
      const r = await api.restock(product.id, {
        quantity: n,
        note: note.trim() || undefined,
        receivedBy,
      });
      onDone(`Received ${n} × ${product.name}: ${r.product.inventory.available} now available.`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };

  return (
    <form className="restock-form" onSubmit={submit}>
      <div>
        <label htmlFor="restock-qty">Units received</label>
        <input
          id="restock-qty"
          ref={input}
          type="number"
          min={1}
          max={10000}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        {suggestion && (
          <div className="muted small">
            Suggested: {suggestion} (back to {product.inventory.reorderPoint * 2} available)
          </div>
        )}
      </div>
      <div className="grow">
        <label htmlFor="restock-note">Note (optional)</label>
        <input
          id="restock-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Supplier or batch reference"
        />
      </div>
      <div className="restock-actions">
        <button className="btn" disabled={!valid || busy}>
          {busy ? 'Saving…' : `Receive ${valid ? n : ''}`}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <ErrorMessage error={error} />}
    </form>
  );
}
