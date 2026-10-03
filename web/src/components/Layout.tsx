import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/new', label: 'New Request' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/audit', label: 'Audit Log' },
  { to: '/orders', label: 'Orders' },
  { to: '/inventory', label: 'Inventory' },
];

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✿
          </span>{' '}
          Petal &amp; Ink · Order Manager
        </span>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
