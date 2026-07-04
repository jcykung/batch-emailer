// src/microsoftSync.js

let msalInstance = null;

/**
 * Get or initialize the MSAL instance.
 * @param {string} clientId 
 * @param {string} tenantId 
 */
export async function getMsalInstance(clientId, tenantId) {
    if (!clientId) {
        throw new Error("Microsoft Client ID is not configured. Please set it in Settings.");
    }
    
    if (msalInstance) {
        const currentConfig = msalInstance.getConfiguration();
        if (currentConfig.auth.clientId === clientId && 
            currentConfig.auth.authority.includes(tenantId || 'common')) {
            return msalInstance;
        }
    }

    if (!window.msal) {
        throw new Error("Microsoft Identity Library (MSAL) failed to load from CDN. Please check your network connection.");
    }

    const config = {
        auth: {
            clientId: clientId,
            authority: `https://login.microsoftonline.com/${tenantId || 'common'}`,
            redirectUri: window.location.origin,
            navigateToLoginRequestUrl: false
        },
        cache: {
            cacheLocation: 'localStorage',
            storeAuthStateInCookie: false,
        }
    };

    const pca = new window.msal.PublicClientApplication(config);
    await pca.initialize();
    msalInstance = pca;
    return msalInstance;
}

/**
 * Sign in using popup.
 */
export async function signIn(clientId, tenantId) {
    const instance = await getMsalInstance(clientId, tenantId);
    const loginRequest = {
        scopes: ['User.Read', 'Files.ReadWrite'],
        prompt: 'select_account'
    };
    
    try {
        const result = await instance.loginPopup(loginRequest);
        instance.setActiveAccount(result.account);
        return result.account;
    } catch (error) {
        console.error("Microsoft Login failed:", error);
        throw error;
    }
}

/**
 * Sign out.
 */
export async function signOut(clientId, tenantId) {
    try {
        const instance = await getMsalInstance(clientId, tenantId);
        const account = instance.getActiveAccount();
        if (account) {
            await instance.logoutPopup({
                account: account,
                mainWindowRedirectUri: window.location.origin
            });
        }
    } catch (error) {
        console.error("Microsoft Logout failed:", error);
    }
}

/**
 * Get active account or recover it from cache.
 */
export async function getActiveAccount(clientId, tenantId) {
    try {
        const instance = await getMsalInstance(clientId, tenantId);
        let account = instance.getActiveAccount();
        if (!account) {
            const accounts = instance.getAllAccounts();
            if (accounts.length > 0) {
                account = accounts[0];
                instance.setActiveAccount(account);
            }
        }
        return account;
    } catch (e) {
        return null;
    }
}

/**
 * Acquire access token.
 */
export async function getAccessToken(clientId, tenantId) {
    const instance = await getMsalInstance(clientId, tenantId);
    let account = await getActiveAccount(clientId, tenantId);
    
    if (!account) {
        throw new Error("No signed-in Microsoft account. Please connect first.");
    }
    
    const tokenRequest = {
        scopes: ['User.Read', 'Files.ReadWrite'],
        account: account
    };
    
    try {
        const response = await instance.acquireTokenSilent(tokenRequest);
        return response.accessToken;
    } catch (error) {
        console.warn("Silent token acquisition failed, attempting popup:", error);
        const response = await instance.acquireTokenPopup(tokenRequest);
        return response.accessToken;
    }
}

/**
 * Fetch the data file from OneDrive.
 */
export async function fetchFromOneDrive(clientId, tenantId) {
    const token = await getAccessToken(clientId, tenantId);
    
    // Target path: Documents/batch-emailer-data.json
    const response = await fetch("https://graph.microsoft.com/v1.0/me/drive/root:/Documents/batch-emailer-data.json:/content", {
        headers: {
            "Authorization": `Bearer ${token}`
        }
    });
    
    if (response.status === 404) {
        return null; // File doesn't exist yet
    }
    
    if (!response.ok) {
        throw new Error(`Failed to download data from OneDrive (${response.status} ${response.statusText})`);
    }
    
    return await response.json();
}

/**
 * Save the data file to OneDrive.
 */
export async function saveToOneDrive(data, clientId, tenantId) {
    const token = await getAccessToken(clientId, tenantId);
    
    const response = await fetch("https://graph.microsoft.com/v1.0/me/drive/root:/Documents/batch-emailer-data.json:/content", {
        method: "PUT",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });
    
    if (!response.ok) {
        throw new Error(`Failed to upload data to OneDrive (${response.status} ${response.statusText})`);
    }
    
    return await response.json();
}
