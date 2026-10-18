export async function createSessionHeaders(
  apiUrl,
  {
    email = process.env.TEST_USER_EMAIL ?? "dev@example.com",
    password = process.env.TEST_USER_PASSWORD ?? process.env.DEV_USER_PASSWORD,
  } = {},
) {
  if (!password) {
    throw new Error(
      "Set TEST_USER_PASSWORD or DEV_USER_PASSWORD to authenticate integration tests",
    );
  }

  const response = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Integration test login failed (${response.status}): ${body}`,
    );
  }

  const setCookie = response.headers.get("set-cookie");
  const sessionCookie = setCookie?.split(";")[0];
  if (!sessionCookie) {
    throw new Error("Integration test login did not return a session cookie");
  }

  return {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
  };
}
