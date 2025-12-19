// src/api/auth/socialAuth.js
import express from "express";
import crypto from "node:crypto";

const router = express.Router();

const PROVIDER_CONFIG = {
  facebook: {
    authUrl:
      process.env.FACEBOOK_OAUTH_URL ||
      "https://www.facebook.com/v19.0/dialog/oauth",
    fallback: "https://www.facebook.com/login.php",
    clientId: process.env.FACEBOOK_APP_ID,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI,
    scope:
      process.env.FACEBOOK_OAUTH_SCOPE ||
      "pages_show_list,pages_read_engagement,public_profile,email",
    responseType: "code",
  },
  instagram: {
    authUrl:
      process.env.INSTAGRAM_OAUTH_URL ||
      "https://api.instagram.com/oauth/authorize",
    fallback: "https://www.instagram.com/accounts/login/",
    clientId: process.env.INSTAGRAM_APP_ID,
    redirectUri: process.env.INSTAGRAM_REDIRECT_URI,
    scope:
      process.env.INSTAGRAM_OAUTH_SCOPE ||
      "user_profile,user_media,instagram_basic",
    responseType: "code",
  },
  linkedin: {
    authUrl:
      process.env.LINKEDIN_OAUTH_URL ||
      "https://www.linkedin.com/oauth/v2/authorization",
    fallback: "https://www.linkedin.com/login",
    clientId: process.env.LINKEDIN_CLIENT_ID,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI,
    scope:
      process.env.LINKEDIN_OAUTH_SCOPE ||
      "r_liteprofile r_emailaddress w_member_social",
    responseType: "code",
  },
};

function buildAuthUrl(provider) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return null;

  if (!config.clientId || !config.redirectUri) {
    return config.fallback;
  }

  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", config.responseType || "code");
  if (config.scope) url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", crypto.randomUUID());
  if (provider === "instagram") {
    url.searchParams.set("enable_fb_login", "1");
  }
  return url.toString();
}

router.get("/social/:provider", (req, res) => {
  const provider = req.params.provider?.toLowerCase();
  if (!provider || !PROVIDER_CONFIG[provider]) {
    return res.status(404).json({ ok: false, error: "Unsupported provider" });
  }
  const authUrl = buildAuthUrl(provider);
  if (!authUrl) {
    return res.status(500).json({ ok: false, error: "Unable to build auth URL" });
  }
  return res.redirect(authUrl);
});

export default router;
