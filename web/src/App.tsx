import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Approvals } from './pages/Approvals';
import { AuditLogPage } from './pages/AuditLogPage';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { NewRequest } from './pages/NewRequest';
import { NotFound } from './pages/NotFound';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="new" element={<NewRequest />} />
            <Route path="inbox" element={<Navigate to="/new" replace />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="audit/:id" element={<AuditLogPage />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:id" element={<OrderDetail />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
