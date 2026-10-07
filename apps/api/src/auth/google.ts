import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";



function getSafeClientIdSuffix(clientId: string): string {
    return clientId.length > 12 ? `...${clientId.slice(-12)}` : "[short]";
}

//just gets the identity of our app.
export function getGoogleConfig() {
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const GOOGLE_CALLBACK_URL = (process.env.GOOGLE_CALLBACK_URL ?? "http://localhost:3000/auth/google/callback").trim();

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        throw new Error("Missing Google OAuth credentials. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the .env file.");
    }

    return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL };
}
//building our url , so the scope is all the permissions we want, here after we give 
//accept the permissions , the auth code is sent alongside our callback URL
export function getGoogleAuthUrl() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL } = getGoogleConfig();

    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = {
        redirect_uri: GOOGLE_CALLBACK_URL,//after auth is done send code here
        client_id: GOOGLE_CLIENT_ID,//this is chronolog
        access_type: "offline",//we want a refresh token
        response_type: "code",//give me the authorization code
        prompt: "consent",//always ask for consent
        scope: [//the things we want permissions for
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/tasks",
            "https://www.googleapis.com/auth/calendar.readonly",
        ].join(" "),
    };

    const qs = new URLSearchParams(options);
    console.log(`[Auth/Google] Generated auth URL. Client ID suffix: ${getSafeClientIdSuffix(GOOGLE_CLIENT_ID)}, Redirect URI: "${GOOGLE_CALLBACK_URL}"`);
    return `${rootUrl}?${qs.toString()}`;
}

export interface GoogleTokensResult {
    access_token: string;
    id_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
}

// In-flight and short-term cache to deduplicate concurrent or rapid duplicate token exchange requests
const tokenExchangeCache = new Map<string, Promise<GoogleTokensResult>>();

export async function getGoogleTokens(code: string, redirectUri?: string): Promise<GoogleTokensResult> {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = getGoogleConfig();
    const effectiveRedirectUri = (redirectUri !== undefined ? redirectUri : GOOGLE_CALLBACK_URL).trim();

    const trimmedCode = code.trim();
    const codeFingerprint = `${trimmedCode.slice(0, 4)}...${trimmedCode.slice(-4)}`;

    if (tokenExchangeCache.has(trimmedCode)) {
        console.log(`[Auth/Tokens] Reusing in-flight/recent token exchange for code [${codeFingerprint}]`);
        return tokenExchangeCache.get(trimmedCode)!;
    }

    console.log(
        `[Auth/Tokens] Initiating token exchange for code [${codeFingerprint}]. Client ID suffix: ${getSafeClientIdSuffix(GOOGLE_CLIENT_ID)}, redirect_uri: "${effectiveRedirectUri}"`
    );

    const exchangePromise = (async () => {
        const url = "https://oauth2.googleapis.com/token";
        const values: Record<string, string> = {
            code: trimmedCode,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: effectiveRedirectUri,
            grant_type: "authorization_code",
        };

        //exchange code for tokens
        //just fetching to tokens here
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(values).toString(),
        });

        if (!res.ok) {
            const errorBody = await res.text();
            console.error(`[Auth/Tokens] Google token exchange rejected (HTTP ${res.status}): ${errorBody}`);
            throw new Error(`Failed to fetch Google tokens: ${errorBody}`);
        }

        console.log(`[Auth/Tokens] Token exchange successful for code [${codeFingerprint}]`);
        return res.json() as Promise<GoogleTokensResult>;
    })();

    tokenExchangeCache.set(trimmedCode, exchangePromise);

    // Keep cached for 30s to prevent duplicate code submissions from triggering invalid_grant
    setTimeout(() => {
        tokenExchangeCache.delete(trimmedCode);
    }, 30000);

    return exchangePromise;
}

export async function refreshGoogleTokens(refresh_token: string) {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = getGoogleConfig();
    const url = "https://oauth2.googleapis.com/token";
    const values = {
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: "refresh_token",
    };

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(values).toString(),
    });

    if (!res.ok) {
        throw new Error(`Failed to refresh Google tokens: ${await res.text()}`);
    }

    return res.json() as Promise<{
        access_token: string;
        expires_in: number;
        scope: string;
        token_type: string;
    }>;
}

export async function getGoogleUser(id_token: string, access_token: string) {
    const res = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?alt=json&access_token=${access_token}`, {
        headers: {
            Authorization: `Bearer ${id_token}`,
        },
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch Google user profile: ${await res.text()}`);
    }

    return res.json() as Promise<{
        id: string;
        email: string;
        verified_email: boolean;
        name: string;
        given_name: string;
        family_name: string;
        picture: string;
        locale: string;
    }>;
}

export async function getValidAccessToken(userId: number) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.googleAccessToken) {
        throw new Error("No Google access token found for user");
    }

    if (user.googleTokenExpiresAt && user.googleTokenExpiresAt.getTime() < Date.now() + 60000) {
        if (!user.googleRefreshToken) {
            throw new Error("Google access token expired and no refresh token available");
        }
        const newTokens = await refreshGoogleTokens(user.googleRefreshToken);
        const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

        await db.update(users).set({
            googleAccessToken: newTokens.access_token,
            googleTokenExpiresAt: expiresAt,
        }).where(eq(users.id, userId));

        return newTokens.access_token;
    }

    return user.googleAccessToken;
}
