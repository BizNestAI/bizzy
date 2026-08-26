const BUILD_STARTED_AT = new Date().toISOString();

export function getBackendBuildInfo() {
  const env = process.env || {};
  const gitSha =
    env.RAILWAY_GIT_COMMIT_SHA ||
    env.RAILWAY_GIT_COMMIT_HASH ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.GIT_COMMIT_SHA ||
    env.COMMIT_SHA ||
    env.SOURCE_VERSION ||
    env.RENDER_GIT_COMMIT ||
    null;
  const deployId =
    env.RAILWAY_DEPLOYMENT_ID ||
    env.VERCEL_DEPLOYMENT_ID ||
    env.RENDER_SERVICE_ID ||
    null;
  return {
    git_sha: gitSha,
    git_sha_short: gitSha ? String(gitSha).slice(0, 12) : null,
    deploy_id: deployId,
    service_id: env.RAILWAY_SERVICE_ID || env.RAILWAY_PROJECT_ID || null,
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.VERCEL_ENV || env.NODE_ENV || null,
    node_env: env.NODE_ENV || null,
    build_started_at: BUILD_STARTED_AT,
  };
}
