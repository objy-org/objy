import { json, readJson } from "../http-router.js";

export function createAuthInterface() {
  return {
    name: "auth",
    register(router, { auth }) {
      router.post("/api/:database/:collection/auth", async (req, res) => {
        try {
          const body = await readJson(req);
          const result = auth.login(req.params.database, req.params.collection, body?.username, body?.password);
          if (!result) return json(res, 401, { error: "invalid username or password" });
          json(res, 200, result);
        } catch (err) {
          json(res, err.status || 500, { error: err.message });
        }
      });

      router.post("/api/:database/:collection/renew", async (req, res) => {
        try {
          const body = await readJson(req);
          json(res, 200, auth.renew(req.params.database, req.params.collection, body?.refreshToken));
        } catch (err) {
          json(res, err.status || 500, { error: err.message });
        }
      });
    },
  };
}
