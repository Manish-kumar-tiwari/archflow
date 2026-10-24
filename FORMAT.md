# Archflow editable diagram JSON — version 1

The editor imports and exports UTF-8 JSON. A file uses this envelope:

```json
{
  "format": "archflow-diagram",
  "schemaVersion": 1,
  "diagram": {
    "name": "Global storefront",
    "data": {
      "schemaVersion": 1,
      "nodes": [],
      "edges": [],
      "layers": [],
      "customTypes": [],
      "viewport": { "x": 0, "y": 0, "zoom": 1 }
    }
  }
}
```

The import accepts either the full envelope above, `{ "schemaVersion": 1, "nodes": [...], "edges": [...], "layers": [...] }`, or the inner `diagram.data` object.

## Components

Each node has a unique string `id`, a string `type` and `name`, numeric `x`, `y`, `w`, and `h`, an optional `description`, `icon`, `layer`, `locked`, `group`, and a JSON object `props`. Positions and sizes are in canvas units. Standard component types include `client`, `web`, `mobile`, `api`, `service`, `function`, `database`, `cache`, `queue`, `storage`, `network`, `cloud`, and `external`.

Custom definitions live in `customTypes` as objects with `type`, `name`, `description`, `icon`, and `props`. Custom nodes use that type string. Unknown node types remain valid and render with a neutral component style.

The built-in drawing types are `shape-rectangle`, `shape-rounded`, `shape-ellipse`, `shape-diamond`, `text-note`, and `freehand`. Shape nodes keep their shape (`rectangle`, `rounded`, `ellipse`, or `diamond`), fill, outline, and label color in `props`. Text notes use `fontStyle` (`standard` or `handwritten`), `fontSize`, `color`, and `background` (a hex color or `transparent`). Freehand nodes store a `points` array of `{ "x": number, "y": number }` coordinates relative to the node's top-left corner, plus `stroke` and `strokeWidth`. The server accepts 2–10,000 points per stroke and checks that points stay within the node bounds.

## Connections

Each edge has a unique string `id`, `source` and `target` ids that refer to existing nodes, an optional `label`, `style` (`solid` or `dashed`), `direction` (`forward`, `both`, or `none`), and optional hex `color`.

## Layers and comments

Layer records have a unique string `id`, `name`, and optional booleans `visible` and `locked`. Comments are stored separately by the server so the diagram JSON remains portable. A comment anchor is either `{ "type": "node", "nodeId": "..." }` or `{ "type": "point", "x": 120, "y": 40 }`.

## Validation and evolution

Version 1 requires unique node/edge ids and existing edge endpoints. Server imports are capped at 10,000 nodes, 20,000 edges, 200 layers, 100 custom component definitions, and 5 MB serialized JSON. The server rejects unsupported `schemaVersion` values. Future incompatible changes should introduce a new version and a migration path; do not silently reinterpret an older version.
