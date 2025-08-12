import React, { useState, useEffect } from 'react';
import { Auth0Service, DeviceAuthState, TokenResponse, Auth0UserInfo } from './main';

interface LoginComponentProps {
	auth0Service: Auth0Service;
	onLoginSuccess: (userInfo: Auth0UserInfo) => void;
	onLoginError: (error: string) => void;
	onCancel: () => void;
}

interface LoginState {
	step: 'loading' | 'device-code' | 'polling' | 'timeout' | 'error' | 'success';
	deviceAuth?: DeviceAuthState;
	errorMessage?: string;
	timeRemaining?: number;
}

export const LoginComponent: React.FC<LoginComponentProps> = ({
	auth0Service,
	onLoginSuccess,
	onLoginError,
	onCancel
}) => {
	const [state, setState] = useState<LoginState>({ step: 'loading' });
	const [countdownTimer, setCountdownTimer] = useState<NodeJS.Timeout | null>(null);
	const [showManualLogin, setShowManualLogin] = useState<boolean>(false);

	useEffect(() => {
		startDeviceAuth();
		return () => {
			// Clean up timer
			if (countdownTimer) {
				clearInterval(countdownTimer);
			}
			// Stop polling
			auth0Service.stopPolling();
		};
	}, []);

	const startDeviceAuth = async () => {
		try {
			setState({ step: 'loading' });
			
			// Start Device Authorization Flow
			const deviceAuth = await auth0Service.startDeviceAuth();
			
			setState({ 
				step: 'device-code', 
				deviceAuth,
				timeRemaining: deviceAuth.expires_in
			});

			// Start countdown timer
			startCountdown(deviceAuth.expires_in);
			
			// Start polling
			startPolling(deviceAuth);
			
		} catch (error: any) {
			console.error('Device auth failed:', error);
			setState({ 
				step: 'error', 
				errorMessage: error.message || 'Failed to start login process' 
			});
			onLoginError(error.message || 'Failed to start login process');
		}
	};

	const startCountdown = (seconds: number) => {
		if (countdownTimer) {
			clearInterval(countdownTimer);
		}

		let remaining = seconds;
		setState(prev => ({ ...prev, timeRemaining: remaining }));

		const timer = setInterval(() => {
			remaining -= 1;
			setState(prev => ({ ...prev, timeRemaining: remaining }));

			if (remaining <= 0) {
				clearInterval(timer);
				setState(prev => ({ ...prev, step: 'timeout' }));
				auth0Service.stopPolling();
			}
		}, 1000);

		setCountdownTimer(timer);
	};

	const startPolling = async (deviceAuth: DeviceAuthState) => {
		try {
			// Don't immediately switch to polling state, let user see device-code state first
			// Start polling for token
			const tokenResponse = await auth0Service.pollForToken(
				deviceAuth.device_code, 
				deviceAuth.interval
			);

			// Get user information
			await handleLoginSuccess(tokenResponse);

		} catch (error: any) {
			console.error('Polling failed:', error);
			
			// Ensure polling operation is stopped
			auth0Service.stopPolling();
			
			if (error.message.includes('timeout')) {
				setState({ step: 'timeout' });
			} else {
				setState({ 
					step: 'error', 
					errorMessage: error.message || 'Authorization failed' 
				});
				onLoginError(error.message || 'Authorization failed');
			}
		}
	};

	const handleLoginSuccess = async (tokenResponse: TokenResponse) => {
		try {
			// Stop countdown timer
			if (countdownTimer) {
				clearInterval(countdownTimer);
			}

			// Stop polling operation
			auth0Service.stopPolling();

			setState({ step: 'success' });

			// Save token to plugin settings (through auth0Service)
			const plugin = (auth0Service as any).plugin;
			plugin.settings.isLoggedIn = true;
			plugin.settings.accessToken = tokenResponse.access_token;
			plugin.settings.refreshToken = tokenResponse.refresh_token;
			plugin.settings.tokenExpiry = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;

			// Get user information
			const userInfo = await auth0Service.getUserInfo();
			plugin.settings.userInfo = {
				email: userInfo.email,
				name: userInfo.name,
				sub: userInfo.sub
			};

			// Save settings
			await plugin.saveSettings();

			// Setup token refresh timer
			auth0Service.setupTokenRefreshTimer();

			onLoginSuccess(userInfo);

		} catch (error: any) {
			console.error('Failed to save login state:', error);
			
			// Ensure polling operation is stopped
			auth0Service.stopPolling();
			
			setState({ 
				step: 'error', 
				errorMessage: 'Failed to save login state: ' + error.message 
			});
			onLoginError('Failed to save login state: ' + error.message);
		}
	};

	const handleRetry = () => {
		// Ensure previous polling operation is stopped
		auth0Service.stopPolling();
		
		// Clean up countdown timer
		if (countdownTimer) {
			clearInterval(countdownTimer);
			setCountdownTimer(null);
		}
		
		startDeviceAuth();
	};

	const formatTime = (seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	};

	const copyToClipboard = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.error('Copy failed:', err);
		}
	};

	return (
		<div className="login-component">
			<div className="login-header">
				<h2>Log in to Agentmode</h2>
			</div>

			<div className="login-content">
				{state.step === 'loading' && (
					<div className="loading-state">
						<div className="spinner"></div>
						<p>Initializing login process...</p>
					</div>
				)}

				{state.step === 'device-code' && state.deviceAuth && (
					<div className="device-code-state">
						<div className="login-options">
							<h3>Choose Login Method</h3>
							
							{/* Primary option: One-click login */}
							<div className="primary-login-option">
								<button 
									className="primary-login-btn"
									onClick={() => window.open(state.deviceAuth?.verification_uri_complete, '_blank')}
								>
									Open Login Page in Browser
								</button>
								<p className="primary-login-desc">Click to automatically open browser and complete login</p>
							</div>

							{/* Manual login option (collapsible) */}
							<div className="manual-login-section">
								<button 
									className="manual-login-toggle"
									onClick={() => setShowManualLogin(!showManualLogin)}
								>
									{showManualLogin ? 'Hide' : "Can't auto-open? Manual login"}
									<span className={`toggle-arrow ${showManualLogin ? 'expanded' : ''}`}>▼</span>
								</button>
								
								{showManualLogin && (
									<div className="manual-login-content">
										<p className="manual-instruction">
											Please visit the following URL in your browser and enter the device code:
										</p>
										
										<div className="verification-info">
											<div className="url-section">
												<label>Verification URL:</label>
												<div className="copy-field">
													<code>{state.deviceAuth.verification_uri}</code>
													<button 
														className="copy-btn"
														onClick={() => copyToClipboard(state.deviceAuth!.verification_uri)}
													>
														Copy
													</button>
												</div>
											</div>

											<div className="code-section">
												<label>Device Code:</label>
												<div className="copy-field">
													<code className="device-code">{state.deviceAuth.user_code}</code>
													<button 
														className="copy-btn"
														onClick={() => copyToClipboard(state.deviceAuth!.user_code)}
													>
														Copy
													</button>
												</div>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>

						{state.timeRemaining && (
							<div className="countdown">
								<p>Time remaining: {formatTime(state.timeRemaining)}</p>
							</div>
						)}
					</div>
				)}

			

				{state.step === 'polling' && (
					<div className="polling-state">
						<div className="spinner"></div>
						<p>Waiting for authorization...</p>
						<p>Please complete login in your browser</p>
						{state.timeRemaining && (
							<div className="countdown">
								<p>Time remaining: {formatTime(state.timeRemaining)}</p>
							</div>
						)}
					</div>
				)}

				{state.step === 'timeout' && (
					<div className="timeout-state">
						<div className="error-icon">⏰</div>
						<h3>Login Timeout</h3>
						<p>Login process has timed out, please try again.</p>
						<div className="timeout-actions">
							<button className="retry-btn" onClick={handleRetry}>
								Retry Login
							</button>
							<button className="cancel-btn" onClick={onCancel}>
								Cancel
							</button>
						</div>
					</div>
				)}

				{state.step === 'error' && (
					<div className="error-state">
						<div className="error-icon">❌</div>
						<h3>Login Failed</h3>
						<p>{state.errorMessage}</p>
						<div className="error-actions">
							<button className="retry-btn" onClick={handleRetry}>
								Retry
							</button>
							<button className="cancel-btn" onClick={onCancel}>
								Cancel
							</button>
						</div>
					</div>
				)}

				{state.step === 'success' && (
					<div className="success-state">
						<div className="success-icon">✅</div>
						<h3>Login Successful</h3>
						<p>Completing setup...</p>
					</div>
				)}
			</div>
		</div>
	);
}; 