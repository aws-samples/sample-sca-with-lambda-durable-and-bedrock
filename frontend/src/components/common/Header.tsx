import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import './Header.css';

export const Header = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-brand">
          <img src="/lambda-logo.svg" alt="AWS Lambda" className="header-logo" />
          <h1 className="header-title">Conversational Analytics</h1>
        </div>
        {user && (
          <div className="header-user">
            <span className="user-name">{user.email || user.username}</span>
            <button onClick={handleLogout} className="button logout-button">
              Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
