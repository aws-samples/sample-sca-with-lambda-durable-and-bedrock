import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Amplify } from 'aws-amplify';
import { signIn, signOut, getCurrentUser, fetchAuthSession, confirmSignIn } from 'aws-amplify/auth';
import { AuthState } from '../types';

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<{ requiresNewPassword: boolean }>;
  logout: () => Promise<void>;
  completeNewPassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Configure Amplify with Cognito settings
// These values should come from environment variables in production
const configureAmplify = () => {
  const userPoolId = process.env.REACT_APP_USER_POOL_ID || '';
  const userPoolClientId = process.env.REACT_APP_USER_POOL_CLIENT_ID || '';
  
  // Only configure if we have the required values
  if (userPoolId && userPoolClientId) {
    try {
      Amplify.configure({
        Auth: {
          Cognito: {
            userPoolId,
            userPoolClientId,
          }
        }
      });
    } catch (error) {
      console.error('Failed to configure Amplify:', error);
    }
  }
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    configureAmplify();
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      
      if (currentUser && session.tokens) {
        setAuthState({
          user: {
            username: currentUser.username,
            email: currentUser.signInDetails?.loginId,
            token: session.tokens.idToken?.toString() || '',
          },
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      } else {
        setAuthState({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      }
    } catch (error) {
      setAuthState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    }
  };

  const login = async (username: string, password: string) => {
    setAuthState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const signInOutput = await signIn({ username, password });
      
      // Check if user needs to change password
      if (signInOutput.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setAuthState(prev => ({ ...prev, isLoading: false }));
        return { requiresNewPassword: true };
      }
      
      if (signInOutput.isSignedIn) {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession();
        
        setAuthState({
          user: {
            username: currentUser.username,
            email: currentUser.signInDetails?.loginId,
            token: session.tokens?.idToken?.toString() || '',
          },
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
        
        return { requiresNewPassword: false };
      }
      
      return { requiresNewPassword: false };
    } catch (error) {
      setAuthState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      throw error;
    }
  };

  const completeNewPassword = async (newPassword: string) => {
    setAuthState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      const confirmOutput = await confirmSignIn({ challengeResponse: newPassword });
      
      if (confirmOutput.isSignedIn) {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession();
        
        setAuthState({
          user: {
            username: currentUser.username,
            email: currentUser.signInDetails?.loginId,
            token: session.tokens?.idToken?.toString() || '',
          },
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      }
    } catch (error) {
      setAuthState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Password change failed',
      }));
      throw error;
    }
  };

  const logout = async () => {
    try {
      await signOut();
      setAuthState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      console.error('Logout error:', error);
      // Force logout on client side even if server call fails
      setAuthState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      });
    }
  };

  return (
    <AuthContext.Provider value={{ ...authState, login, logout, completeNewPassword }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
