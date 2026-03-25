import React from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Inbox from './pages/Inbox';
import InternalChat from './pages/InternalChat';
import Tasks from './pages/Tasks';
import Occurrences from './pages/Occurrences';
import Customers from './pages/Customers';
import Employees from './pages/Employees';
import Reports from './pages/Reports';
import CallImport from './pages/CallImport';
import AutoResponses from './pages/AutoResponses';
import ResponseForms from './pages/ResponseForms';
import SoftwareHub from './pages/SoftwareHub';
import Login from './pages/Login';
import { mockService } from './services/mockData';

const ProtectedApp: React.FC = () => {
  if (!mockService.isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/internal-chat" element={<InternalChat />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/occurrences" element={<Occurrences />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/software" element={<SoftwareHub />} />
        <Route path="/automation" element={<AutoResponses />} />
        <Route path="/response-forms" element={<ResponseForms />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/import" element={<CallImport />} />
        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Routes>
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<ProtectedApp />} />
      </Routes>
    </Router>
  );
};

export default App;
