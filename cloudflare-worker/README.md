# Tussenstation voor "Recept van een link"

Draait als Cloudflare Worker `lijstjes-recepten`. Haalt een receptpagina op en geeft alleen de receptgegevens (schema.org/Recipe) terug. Niet-Nederlandse recepten worden omgerekend (cups, oz, °F) en vertaald met Workers AI; daarvoor heeft de worker een binding "AI" (Workers AI).
Bijwerken: in het Cloudflare-dashboard bij de worker op "Edit code", alles vervangen door worker.js, en "Deploy".
