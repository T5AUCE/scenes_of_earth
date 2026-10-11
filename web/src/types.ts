// Shapes of backend responses. Filled in from M2 on (scene status, scene.json, layers).

export interface Health {
  ok: boolean;
  version: string;
}
