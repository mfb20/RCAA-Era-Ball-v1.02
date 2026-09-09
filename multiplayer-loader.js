"use strict";

(async function loadSharedMultiplayerData() {
  const badge = document.getElementById("connectionBadge");
  const errorBox = document.getElementById("setupError");

  try {
    const cfg = window.REB_SUPABASE_CONFIG;
    if (!window.supabase || !cfg) throw new Error("Supabase client configuration is missing.");

    const bootstrap = window.supabase.createClient(cfg.url, cfg.publishableKey);
    const { data: sessionData } = await bootstrap.auth.getSession();
    if (!sessionData.session) {
      const { error: authError } = await bootstrap.auth.signInAnonymously();
      if (authError) throw authError;
    }

    const { data, error } = await bootstrap
      .from("rcaa_players")
      .select("player_data")
      .order("season", { ascending: true })
      .order("team_code", { ascending: true })
      .order("player_name", { ascending: true });
    if (error) throw error;

    window.REB_PLAYER_POOL = (data || []).map((row) => row.player_data);
    if (window.REB_PLAYER_POOL.length !== 203) {
      throw new Error(`Expected 203 RCAA player cards, found ${window.REB_PLAYER_POOL.length}.`);
    }

    const script = document.createElement("script");
    script.src = "./multiplayer.js";
    script.defer = false;
    script.onerror = () => {
      throw new Error("Could not load the multiplayer game client.");
    };
    document.body.appendChild(script);
  } catch (error) {
    if (badge) badge.textContent = "OFFLINE";
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error?.message || "Multiplayer failed to initialize.";
    }
    console.error("REB multiplayer bootstrap failed", error);
  }
})();
