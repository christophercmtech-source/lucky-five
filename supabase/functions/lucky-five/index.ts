import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});
const randomToken = (bytes = 32) => {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
};
async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "create") {
      const inviteCode = randomToken(4).slice(0, 7).toUpperCase();
      const adminToken = randomToken();
      const { error } = await supabase.rpc("lf_create_game", {
        p_invite_code: inviteCode, p_admin_token_hash: await hash(adminToken),
      });
      if (error) throw error;
      return json({ inviteCode, adminToken });
    }

    if (action === "join") {
      const inviteCode = String(body.inviteCode || "").trim().toUpperCase();
      const name = String(body.name || "").trim();
      const playerToken = randomToken();
      const { data, error } = await supabase.rpc("lf_join_game", {
        p_invite_code: inviteCode, p_display_name: name,
        p_player_token_hash: await hash(playerToken),
      });
      if (error) throw error;
      return json({ ...data, playerToken });
    }

    if (action === "status") {
      const playerToken = String(body.playerToken || "");
      if (!playerToken) return json({ error: "Missing player session." }, 400);
      const { data, error } = await supabase.rpc("lf_player_action", {
        p_player_token_hash: await hash(playerToken), p_action: "status",
      });
      if (error) throw error;
      let isAdmin = false;
      if (body.adminToken) {
        const { data: adminData } = await supabase.rpc("lf_admin_status", {
          p_admin_token_hash: await hash(String(body.adminToken)),
        });
        isAdmin = !!adminData && adminData.game_id === data.game_id;
      }
      return json({ ...data, is_admin: isAdmin });
    }

    if (action === "spin-number" || action === "spin-gift") {
      const playerToken = String(body.playerToken || "");
      if (!playerToken) return json({ error: "Missing player session." }, 400);
      const { data, error } = await supabase.rpc("lf_player_action", {
        p_player_token_hash: await hash(playerToken), p_action: action,
      });
      if (error) throw error;
      return json(data);
    }

    if (action === "set-couples") {
      const adminToken = String(body.adminToken || "");
      if (!adminToken) return json({ error: "Only the game host can choose the couples." }, 403);
      const { data, error } = await supabase.rpc("lf_set_couples", {
        p_admin_token_hash: await hash(adminToken),
        p_pair1_a: body.pair1a, p_pair1_b: body.pair1b,
        p_pair2_a: body.pair2a, p_pair2_b: body.pair2b,
      });
      if (error) throw error;
      return json(data);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return json({ error: message }, 400);
  }
});
