import dotenv from "dotenv";
import express from "express";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static("."));
app.use(express.json());

// Get OAuth2 token from SAP Cloud
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "password");
  params.append("username", process.env.SAP_USERNAME);
  params.append("password", process.env.SAP_PASSWORD);
  params.append("client_id", process.env.SAP_CLIENT_ID);
  params.append("client_secret", process.env.SAP_CLIENT_SECRET);
  if (process.env.SAP_SCOPE) params.append("scope", process.env.SAP_SCOPE);

  console.log("Requesting token from:", process.env.SAP_TOKEN_URL);

  const res = await fetch(process.env.SAP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const responseText = await res.text();

  if (!res.ok) {
    console.error(`Token request failed: ${res.status}`);
    console.error("Response:", responseText.substring(0, 500));
    throw new Error(
      `Token failed: ${res.status} - ${responseText.substring(0, 200)}`,
    );
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    console.error(
      "Failed to parse token response as JSON:",
      responseText.substring(0, 200),
    );
    throw new Error("Token response is not valid JSON");
  }

  if (!data.access_token) throw new Error("No access token received");
  console.log("Token obtained successfully");
  return data.access_token;
}

// Generic function to fetch data from SAP OData service
async function fetchFromSAP() {
  const token = await getAccessToken();
  const url = process.env.SAP_ODATA_URL + `/ZC_ORDER_HEADER_SA`;

  console.log("Fetching from SAP OData:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  console.log("SAP API Response Status:", res.status);

  const responseText = await res.text();

  if (!res.ok) {
    console.error(`SAP API error: ${res.status}`);
    console.error("Response:", responseText.substring(0, 500));
    throw new Error(
      `SAP API error: ${res.status} - Server returned: ${responseText.substring(0, 100)}`,
    );
  }

  let json;
  try {
    console.log("response text", responseText);

    json = JSON.parse(responseText);
  } catch (e) {
    console.error(
      "Failed to parse SAP response as JSON:",
      responseText.substring(0, 200),
    );
    throw new Error(
      "SAP response is not valid JSON - check URL and credentials",
    );
  }

  return json.value || json || [];
}

// API endpoint to fetch data
app.get("/api/data", async (req, res) => {
  try {
    const data = await fetchFromSAP();
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API-Endpunkt für die Status-Action
app.post("/api/changeStatus/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const token = await getAccessToken();

    // Basis-URL (muss auf die Service-Wurzel oder ein Entity Set zeigen)
    const baseUrl = process.env.SAP_ODATA_URL;
    const actionUrl = `${baseUrl}/ZC_ORDER_HEADER_SA(${orderId})/SAP__self.changeStatus`;

    console.log("1. Hole CSRF Token von:", baseUrl);

    // SCHRITT 1: CSRF Token und Session-Cookies abholen
    const csrfRes = await fetch(baseUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-csrf-token": "fetch",
      },
    });

    const csrfToken = csrfRes.headers.get("x-csrf-token");

    // WICHTIG: Cookies sauber formatieren! (Keine Verschwendung von nutzlosen Daten)
    let cookieStr = "";
    const rawCookies = csrfRes.headers.get("set-cookie");
    if (rawCookies) {
      // Node.js fetch() verbindet mehrere Cookies oft mit Komma.
      // Wir holen uns nur den ersten Teil (Name=Wert) vor dem Semikolon.
      cookieStr = rawCookies
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
    }

    if (!csrfToken) {
      throw new Error("SAP hat keinen CSRF-Token gesendet.");
    }

    console.log("2. Auslösen der Action:", actionUrl);

    // SCHRITT 2: Action mit CSRF-Token und SAUBEREN Cookies senden
    const sapRes = await fetch(actionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": "*",
        "x-csrf-token": csrfToken,
        Cookie: cookieStr, // <--- Jetzt ist es sauber!
      },
      body: JSON.stringify({}),
    });
    const responseText = await sapRes.text();

    if (!sapRes.ok) {
      throw new Error(`SAP Error ${sapRes.status}: ${responseText}`);
    }

    const data = JSON.parse(responseText);
    res.json({ success: true, data });
  } catch (error) {
    console.error("Action error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const token = await getAccessToken();
    const baseUrl = process.env.SAP_ODATA_URL;
    const createUrl = `${baseUrl}/ZC_ORDER_HEADER_SA`;

    const csrfRes = await fetch(baseUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-csrf-token": "fetch",
      },
    });

    const csrfToken = csrfRes.headers.get("x-csrf-token");
    let cookieStr = "";
    const rawCookies = csrfRes.headers.get("set-cookie");
    if (rawCookies) {
      cookieStr = rawCookies
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
    }

    const sapRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
        Cookie: cookieStr,
      },
      body: JSON.stringify(req.body),
    });

    const responseText = await sapRes.text();
    if (!sapRes.ok) throw new Error(responseText);
    res.json({ success: true, data: JSON.parse(responseText) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch("/api/orders/:id", async (req, res) => {
  try {
    const token = await getAccessToken();
    const baseUrl = process.env.SAP_ODATA_URL;
    const updateUrl = `${baseUrl}/ZC_ORDER_HEADER_SA(${req.params.id})`;

    const csrfRes = await fetch(baseUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "x-csrf-token": "fetch" },
    });

    const csrfToken = csrfRes.headers.get("x-csrf-token");
    let cookieStr = "";
    const rawCookies = csrfRes.headers.get("set-cookie");
    if (rawCookies) {
      cookieStr = rawCookies
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
    }

    const sapRes = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "If-Match": "*",
        "x-csrf-token": csrfToken,
        Cookie: cookieStr,
      },
      body: JSON.stringify(req.body),
    });

    const responseText = await sapRes.text();
    if (!sapRes.ok) throw new Error(responseText);
    res.json({ success: true, data: JSON.parse(responseText) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    const token = await getAccessToken();
    const baseUrl = process.env.SAP_ODATA_URL;
    const deleteUrl = `${baseUrl}/ZC_ORDER_HEADER_SA(${req.params.id})`;

    const csrfRes = await fetch(baseUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "x-csrf-token": "fetch" },
    });

    const csrfToken = csrfRes.headers.get("x-csrf-token");
    let cookieStr = "";
    const rawCookies = csrfRes.headers.get("set-cookie");
    if (rawCookies) {
      cookieStr = rawCookies
        .split(",")
        .map((c) => c.split(";")[0].trim())
        .join("; ");
    }

    const sapRes = await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": "*",
        "x-csrf-token": csrfToken,
        Cookie: cookieStr,
      },
    });

    if (!sapRes.ok) {
      const responseText = await sapRes.text();
      throw new Error(responseText);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/stock", async (req, res) => {
  try {
    // 1. Hole den sicheren Token, genau wie bei den Bestellungen
    const token = await getAccessToken();
    const url = process.env.SAP_ODATA_URL + "/Stock";

    // 2. Sende die Anfrage mit dem Bearer Token
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`, 
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log("Fehler von SAP:", errorText);
      return res.json({
        success: false,
        error: `SAP Fehler Code: ${response.status}`,
      });
    }

    const data = await response.json();

    const stockData = data.value || data;

    res.json({ success: true, data: stockData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
