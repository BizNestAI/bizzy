# OpenAI production key rotation

The current application keeps `OPENAI_API_KEY` server-side and the frontend must never use an OpenAI SDK or an OpenAI `VITE_*` variable.

Historical repository material used the browser-exposed name `VITE_OPENAI_API_KEY`. It is not possible to conclusively prove from source alone that a real value was never assigned or deployed. Before launch, an operator should rotate the production OpenAI key in the hosting provider, revoke the prior key, redeploy the server, and verify the frontend bundle contains no OpenAI key or sensitive environment-variable name.

Never paste either the old or replacement key into source control, browser configuration, issue trackers, test output, or deployment logs.
