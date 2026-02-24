import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { RealTimeProvider } from './contexts/RealTimeContext';
import { AuthGuard } from './components/auth/AuthGuard';
import { Header } from './components/common/Header';
import { Login } from './components/auth/Login';
import { ContactList } from './components/contacts/ContactList';
import { ContactDetail } from './components/contacts/ContactDetail';
import './App.css';

const App = () => {
  return (
    <AuthProvider>
      <RealTimeProvider>
        <Router>
          <div className="app">
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/contacts"
                element={
                  <AuthGuard>
                    <>
                      <Header />
                      <ContactList />
                    </>
                  </AuthGuard>
                }
              />
              <Route
                path="/contacts/:contactId"
                element={
                  <AuthGuard>
                    <>
                      <Header />
                      <ContactDetail />
                    </>
                  </AuthGuard>
                }
              />
              <Route path="/" element={<Navigate to="/contacts" replace />} />
            </Routes>
          </div>
        </Router>
      </RealTimeProvider>
    </AuthProvider>
  );
};

export default App;
