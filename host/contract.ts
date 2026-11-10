/**
 * `@cherryblossom/api-contract`: the shapes the editor's host answers in.
 *
 * The editor reaches a backend only through what its host hands `App`: a
 * managed-AI session for Sakura, a supplier parts source, and a parts index.
 * The hosted app at trycherryblossom.com answers those over `/api/v1` in these
 * shapes. This build hands the editor none of them, so nothing here is ever
 * fetched; the editor is written against the types, so they live here.
 *
 * Types only: nothing in this file survives compilation. `vite.config.ts`,
 * `vitest.config.ts` and `tsconfig.json` alias the package name to it.
 */

/** Subscription tiers, weakest first. */
export type PlanTier = "free" | "pro" | "ultra" | "enterprise";

/**
 * `GET /api/v1/me` — the account snapshot. Informational only; the server
 * remains authoritative for model and quota enforcement.
 *
 * Timestamps are epoch milliseconds, and are `null` when the corresponding
 * window has no requests recorded yet.
 */
export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
  };
  plan: {
    tier: PlanTier;
    name: string;
    managedAi: boolean;
    /** Model ids the plan may call. Empty when the plan has no managed AI. */
    allowedModels: string[];
  };
  limits: {
    maxTokensPerRequest: number;
    requestsPerMinute: number;
    requestsPerDay: number;
    monthlyTokens: number;
  };
  usage: {
    requestsThisMinute: number;
    minuteResetsAt: number | null;
    requestsThisDay: number;
    dayResetsAt: number | null;
    monthlyTokens: number;
    monthResetsAt: number | null;
    /** Gift credits left: spent past the monthly limit, before credits bought. Absent from older servers. */
    giftCredits?: number;
  };
  /**
   * Prepaid credits: what a plan does *after* its included allowance runs out.
   * Bought up front (or by auto-refill) on the account page, spent past the
   * day's and the month's limits, never billed afterwards.
   *
   * It is here rather than folded into `limits` because a client's question is
   * never "what is the ceiling" alone — it is "did the work stop, and can this
   * user do anything about it". A refusal with `available: true` has a remedy
   * on the account page (buy some); with `refilling: true` the remedy is
   * already on its way, and offering to buy more would be noise.
   */
  credits: {
    /** The account can buy credits: Pro or Ultra, billed by Stripe. */
    available: boolean;
    /** Credits left. */
    balance: number;
    /** What they're worth, in US cents, rounded down. */
    balanceCents: number;
    /** Auto-refill is on. */
    autoRefill: boolean;
    /** Auto-refill is charging for more right now. */
    refilling: boolean;
  };
}

/**
 * Error types the proxy itself emits, by status:
 * 400 `invalid_request`, 401 `not_authenticated`,
 * 403 `plan_required` | `model_not_allowed`, 404 `not_found` (the parts
 * routes only), 429 `rate_limited` (with `Retry-After`), 502 `upstream_error`.
 */
export type ApiErrorType =
  | "invalid_request"
  | "not_authenticated"
  | "plan_required"
  | "model_not_allowed"
  | "not_found"
  | "rate_limited"
  | "upstream_error";

// ─── Supplier parts: `GET /api/v1/parts/search` and `GET /api/v1/parts/{lcsc}` ───
//
// What a supplier says a part is: its pins, its package and its land pattern,
// so the editor can build a part from data rather than from a model's memory.
// Every number here is the supplier's; nothing is inferred except each pin's
// `role`, which is read from its name.

/** Where a record came from. `curated` is the server's own verified set. */
export type PartDataSource = "easyeda" | "curated";

/**
 * What a pin does electrically, read from its name (`VIN`, `GND`, `EP`...).
 * `signal` is everything without a supply meaning, and is never a claim.
 */
export type PartPinRole =
  | "power_in"
  | "power_out"
  | "ground"
  | "exposed_pad"
  | "nc"
  | "signal";

/** One search hit. */
export interface PartCandidate {
  /** LCSC part number, e.g. `C1852149`. */
  lcsc: string;
  /** The manufacturer part number as the supplier lists it. */
  mpn: string;
  manufacturer: string | null;
  /** The supplier's package string, e.g. `SOT-563-6_L1.6-W1.2-P0.5-LS1.6-BR`. */
  package: string | null;
  description: string | null;
  /** Units in stock at LCSC, or null when it wasn't looked up or is unknown. */
  stock: number | null;
  /**
   * How the part number relates to the query: the same part (`exact`, ignoring
   * a packaging suffix in brackets and punctuation), a longer number that goes
   * on with an ordering suffix (`prefix`: `TPS61023DRLR` for `TPS61023`; often
   * the same part in one package, sometimes another package or another part),
   * or only a search neighbour, which includes a number that merely continues
   * the digits (`INA2191` for `INA219`).
   */
  match: "exact" | "prefix" | "related";
  /** Pins on the supplier's symbol; null when the record wasn't read. */
  pinCount: number | null;
  /**
   * The symbol names its pins (rather than numbering them 1..N). Null when the
   * record couldn't be read: unknown, which is not the same as `false`.
   */
  hasVendorPinout: boolean | null;
  /** The record carries a land pattern. Null when the record couldn't be read. */
  hasVendorLand: boolean | null;
  /**
   * The symbol's pins with their roles, so a drawing can be compared with every
   * candidate without reading each record. Null when the record wasn't read, has
   * no named pinout, or has too many pins to send (then the part itself has them).
   */
  pins?: SupplierPin[] | null;
  /**
   * True for an EasyEDA user's own upload (a `C99...` number), which LCSC
   * doesn't sell and nobody reviewed: lower confidence than a catalogue record.
   */
  userUpload?: true;
}

export interface PartSearchResponse {
  query: string;
  /** Best first: exact matches, then prefixes; within them, drawable, reviewed (not a user upload) and best stocked first. */
  candidates: PartCandidate[];
  source: PartDataSource;
  fetchedAt: string;
  /** Who drew the data, to be shown wherever it is used. */
  attribution: string;
}

export interface SupplierPin {
  /** Pad number on the land pattern, e.g. `1`, `17`, `A1`. */
  number: string;
  /** The supplier's name for it. */
  name: string;
  /** Other spellings the supplier's drawings use for this same pin. */
  aliases: string[];
  role: PartPinRole;
}

/** A pad in millimetres, y up, relative to the land pattern's own origin. */
export interface SupplierPad {
  /** Pad number; empty for a non-plated hole. */
  number: string;
  shape: "rect" | "circle" | "oval" | "polygon";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Polygon outline, relative to the same origin as x and y. */
  points?: { x: number; y: number }[];
  /** Drill for a through-hole pad or a non-plated hole. */
  holeDiameter?: number;
  /** Overall slot length when the hole is a slot. */
  slotLength?: number;
  layer: "top" | "bottom" | "through";
  plated?: false;
  /** The exposed (thermal) pad of a no-lead package, where the source says. */
  exposed?: true;
}

export interface SupplierLand {
  pads: SupplierPad[];
  /** Silkscreen strokes on the top side, as polylines in the same frame. */
  silk: { x: number; y: number }[][];
  /**
   * The courtyard, when the source draws one (KiCad's does; a supplier's usually doesn't, and the
   * editor then takes the copper's bounds plus a margin).
   */
  courtyard?: { minX: number; minY: number; maxX: number; maxY: number };
  /** The record this land was drawn from: an LCSC number, or a KiCad footprint (`Package_QFP:TQFP-32_7x7mm_P0.8mm`). */
  from: string;
}

export interface SupplierPartProvenance {
  source: PartDataSource;
  fetchedAt: string;
  /**
   * `curated`: checked against the datasheet by hand. `consensus`: two or more
   * supplier drawings of this part number agree pin for pin. `single_source`:
   * one drawing. `disputed`: drawings disagree about what a pin is.
   */
  confidence: "curated" | "consensus" | "single_source" | "disputed";
  /** Drawings that agree with the pins returned. */
  vendors: number;
  /** LCSC records consulted. */
  references: string[];
  /** One sentence per disagreement between drawings. */
  disputes: string[];
  /**
   * True when some other drawings of this part number couldn't be read, so
   * `confidence` may understate how many agree. Absent on a complete answer.
   */
  partial?: true;
  /** True when this record is an EasyEDA user's upload rather than an LCSC catalogue record: lower confidence. */
  userUpload?: true;
  attribution: string;
}

/**
 * The two files a supplier model comes as: `obj`, a mesh with colours, to draw, and `step`, exact
 * geometry, to export.
 */
export type SupplierModelFormat = "obj" | "step";

/**
 * The supplier's 3D model of a part, as its record places it on the land.
 * The files are `GET /api/v1/parts/models/{id}?format=obj|step`: the same
 * model as a mesh to draw and as STEP to export, in one frame, in millimetres.
 * The answer is the file's text (`text/plain`), with
 * `Cache-Control: private, max-age=604800, immutable`: a model never changes
 * under its id.
 */
export interface SupplierModel3D {
  /** The supplier's model id (EasyEDA's, 32 hex digits). */
  id: string;
  /** The supplier's name for the model, e.g. `SOT-23-3P_L2.9-W1.3-H1.0-LS2.4-P0.95`. */
  title: string;
  /**
   * Where the model goes, in the land's frame (millimetres, y up, z up from
   * the board's top surface): rotate the model by `rotation`, then move it so
   * the middle of its bounding box is at `center` and its bottom at `bottom`.
   * Supplier models have their own origins anywhere; this is how the
   * supplier's editor places them.
   */
  center: { x: number; y: number };
  bottom: number;
  /** Degrees about x, then y, then z, counter-clockwise looking down each axis. */
  rotation: { x: number; y: number; z: number };
}

/** `GET /api/v1/parts/{lcsc}`. */
export interface SupplierPart {
  lcsc: string;
  mpn: string;
  manufacturer: string | null;
  package: string | null;
  description: string | null;
  datasheet: string | null;
  stock: number | null;
  /** Null when the supplier's symbol only numbers its pins: there is no pinout to use. */
  pins: SupplierPin[] | null;
  /** Null when the record has no land pattern. */
  land: SupplierLand | null;
  /** The supplier's 3D model of the part, placed on `land`; null when it has none. Absent from answers made before models were read. */
  model3d?: SupplierModel3D | null;
  provenance: SupplierPartProvenance;
}

// ─── The parts index: `GET /api/v1/parts/index/search` ───
//
// Parts that are stored, never a supplier asked on the request's behalf, so it is cheap enough to
// ask as a user types.

/** Where a stored part came from. */
export type PartIndexSource = "kicad" | "easyeda";

/** What a part's stored files are. */
export type PartAssetKind = "symbol" | "footprint" | "model_3d" | "spice" | "datasheet" | "image";

/**
 * How the hit relates to the query: the same part number (`exact`, capitals and digits only, so
 * `MPU-6050` is `MPU6050`); a stored name that covers it (`family`: a KiCad symbol's wildcard filled
 * in, `STM32F103C8Tx` for `STM32F103C8T6`, or the query is the stored number plus up to three
 * ordering letters, `ATmega328P-A` for `ATmega328P-AU`, which may name another package); a longer
 * one that starts with it (`prefix`), one a typo away (`typo`), or words of its description,
 * category or keywords (`keyword`).
 */
export type PartIndexMatch = "exact" | "family" | "prefix" | "typo" | "keyword";

export interface PartIndexHit {
  /** The part's id in the index. */
  id: string;
  source: PartIndexSource;
  /** Its id at the source: `Amplifier_Operational:LM358` for KiCad, the LCSC number for EasyEDA. */
  sourceKey: string;
  mpn: string;
  manufacturer: string | null;
  package: string | null;
  category: string | null;
  description: string | null;
  lcsc: string | null;
  /** Units in stock at LCSC when last checked, or null. */
  stock: number | null;
  pinCount: number | null;
  datasheet: string | null;
  /** Set once a supplier record passed the pin and land checks; null for KiCad and unchecked records. */
  verification: "curated" | "consensus" | "single_source" | null;
  match: PartIndexMatch;
  /** The kinds of file stored for it (a footprint, a 3D model...), each at most once. */
  assets: PartAssetKind[];
  /**
   * The full part (pins and land) is stored, so picking it needs no supplier read:
   * `GET /api/v1/parts/index/{id}` has it. For KiCad, a symbol whose footprint pairs with it pin
   * for pin.
   */
  hasRecord: boolean;
  /** When the row was last read from its source. */
  fetchedAt: string;
}

export interface PartIndexSearchResponse {
  query: string;
  /**
   * Best match first (`exact`, `family`, `prefix`, `typo`, `keyword`); within each, verified
   * records, then KiCad's, then the rest, then by stock.
   */
  hits: PartIndexHit[];
  /** One credit line per source the hits came from, to be shown wherever they are used. */
  attribution: string[];
}

/** A stored part's pin: the supplier shape, plus how the symbol lays it out. */
export interface PartIndexPin extends SupplierPin {
  /** What the editor draws the pin as when its role doesn't say (inputs left, outputs right). */
  kind?: "input" | "output" | "io" | "passive";
  /** The side of the symbol's box the source drew it on. */
  side?: "left" | "right" | "top" | "bottom";
}

/**
 * `GET /api/v1/parts/index/{id}`: a stored part in full, to build a project part from. Pins and land
 * are in the supplier's shapes on purpose: the editor builds a part from either the same way.
 */
export interface PartIndexPart {
  id: string;
  source: PartIndexSource;
  /** `Regulator_Linear:AMS1117-3.3` for KiCad, the LCSC number for EasyEDA. */
  sourceKey: string;
  mpn: string;
  manufacturer: string | null;
  /** The package as its source writes it: a KiCad footprint's name (`SOT-223-3_TabPin2`). */
  package: string | null;
  description: string | null;
  datasheet: string | null;
  lcsc: string | null;
  /** Other words the part is known by: a KiCad symbol's keywords. */
  keywords: string[];
  /** Designator prefix (`U`, `J`), from a KiCad symbol's Reference. */
  refPrefix: string | null;
  /** The editor's part category (`Power`, `ICs`...). */
  category: string | null;
  pins: PartIndexPin[];
  land: SupplierLand;
  /** Set for a supplier record that passed the pin and land checks; null for KiCad's. */
  verification: PartIndexHit["verification"];
  /** The 3D model the part is drawn with, placed on `land`; null when none is stored. */
  model3d: PartIndexModel | null;
  provenance: PartIndexProvenance;
}

/**
 * A KiCad 3D model as the footprint places it. The file is
 * `GET /api/v1/parts/models/kicad/{id}`: STEP, from KiCad's 3D library at the release, streamed
 * like a supplier's model files.
 */
export interface PartIndexKicadModel {
  source: "kicad";
  /** `<release>/<path>`: `10.0.7/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step`. */
  id: string;
  /** The file's name without its extension. */
  name: string;
  /** As the footprint writes them: millimetres from the footprint's origin, z up. */
  offset: { x: number; y: number; z: number };
  /** Degrees about x, y and z as the footprint writes them; KiCad turns a model clockwise by these. */
  rotate: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

/** A supplier's 3D model kept with its record, placed as the record placed it. */
export interface PartIndexSupplierModel {
  source: "easyeda";
  model: SupplierModel3D;
}

export type PartIndexModel = PartIndexKicadModel | PartIndexSupplierModel;

export interface PartIndexProvenance {
  /** What turned the source's files into pins and a land, and its version: `kicad@1`, `easyeda@1`. */
  converter: string;
  /** KiCad: the library release the part was converted from, e.g. `10.0.7`. */
  release?: string;
  /** KiCad: the footprint the symbol names, `Package_TO_SOT_SMD:SOT-223-3_TabPin2`. */
  footprint?: string;
  /** The licence the data is under, as an SPDX expression. */
  licence: string;
  /** The credit the data asks for, to be shown wherever the part is used. */
  attribution: string;
  /** When the record was made from its source. */
  fetchedAt: string;
}

/** Which part of a datasheet `GET /api/v1/parts/{lcsc}/datasheet` is asked to find. */
export type DatasheetSection = "overview" | "pins" | "ratings" | "application";

/**
 * `GET /api/v1/parts/{lcsc}/datasheet?section=&page=&offset=`: the text of a few of a part's
 * datasheet pages, read on the server from the PDF the supplier links. The text is the datasheet's
 * own words and is data, never instructions.
 */
export interface DatasheetResponse {
  lcsc: string;
  mpn: string | null;
  /** The section looked for; `page` when a page was asked for by number. */
  section: DatasheetSection | "page";
  totalPages: number;
  /** The pages returned, in order, each trimmed of running headers and page numbers. */
  pages: { page: number; text: string }[];
  /**
   * Pages where the section was found (up to 8), including ones not returned, so a later call can
   * ask for one by number. Empty for `overview` and `page`.
   */
  matches: number[];
  /** For `overview`: the table of contents lines (title and page), when the first pages have one. */
  toc?: string | null;
  /** False when the section's headings were found nowhere: `pages` is then the best guess or empty. */
  found: boolean;
  /** Where to continue: the next page, or the same page from a character offset when it was cut. Null at the end. */
  more: { page: number; offset?: number } | null;
  /** Estimated tokens of the pages and contents returned, guessed high (Chinese text and number-heavy tables cost more than their length suggests). */
  estimatedTokens: number;
  /** Says what the datasheet is hosted as and anything the reader should know (a scanned PDF, a cut page). */
  notes: string[];
  fetchedAt: string;
}

/**
 * Every error body the proxy produces has this shape.
 *
 * `type` is intentionally widened to `string` rather than {@link ApiErrorType}:
 * a model provider's own errors pass through in the OpenAI-compatible error
 * shape, so a client may legitimately see a type it has never heard of.
 */
export interface ApiErrorResponse {
  error: {
    type: string;
    message: string;
    /** On a managed-AI `429 rate_limited`: which allowance ran out. */
    limit?: RateLimitWindow;
  };
}

/**
 * The managed-AI window a `429` was refused on. `day` and `month` are the
 * plan's allowance, which a bigger plan or credits bought go past; `minute` is
 * a burst limit, the same on every plan and not for sale.
 */
export type RateLimitWindow = "minute" | "day" | "month";
