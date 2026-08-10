/**
 * Prompt construction — ported verbatim from the Python implementation
 * (backend/tasks.py). Wording is intentionally identical so generated output
 * matches the original pipeline.
 */
import { CUSTOM_VECTORIZE_PROMPT, DALLE2_MAX_PROMPT_CHARS } from "../config.js";

export type VariantPreset = { name: string; instruction: string };

export const VARIANT_STYLE_PRESETS: VariantPreset[] = [
  {
    name: "prisma_pop_magenta",
    instruction:
      "Prisma-like vibrant vector portrait. " +
      "Background: bright magenta/pink gradient with subtle grain/speckles. " +
      "High contrast, glossy highlights on face, smooth gradients, bold color blocks.",
  },
  {
    name: "pastel_lilac_soft",
    instruction:
      "Soft pastel vector portrait. " +
      "Background: lilac/purple gradient with faint diagonal brush/stripe shapes. " +
      "Gentle highlights, smooth skin shading, clean minimal look.",
  },
  {
    name: "sepia_halo_ring",
    instruction:
      "Muted cinematic/sepia vector portrait with soft bloom. " +
      "Background: circular halo behind the head with subtle ornamental patterning. " +
      "Soft vignette, elegant tones, slightly dreamy lighting.",
  },
  {
    name: "mono_face_pink_geometric_ring",
    instruction:
      "Mostly monochrome/near-monochrome portrait (face + clothing desaturated). " +
      "Background: bold pink/orange geometric circular ring with clean lines and arcs. " +
      "Strong contrast, graphic poster style.",
  },
  {
    name: "neutral_studio_grey",
    instruction:
      "Clean realistic-vector portrait with warm skin tones. " +
      "Background: smooth grey studio gradient, minimal, professional. " +
      "Subtle rim light; crisp detailing; premium avatar finish.",
  },
  {
    name: "blue_sky_city_silhouette",
    instruction:
      "Clean vector portrait with soft daylight lighting. " +
      "Background: light blue sky gradient with faint city/architectural silhouettes. " +
      "Calm, airy look; subtle haze depth.",
  },
  {
    name: "teal_glow_aura",
    instruction:
      "Modern cinematic vector portrait. " +
      "Background: teal glow aura behind the subject with soft particles/bokeh. " +
      "Slight rim light, cool highlights, premium digital-art vibe.",
  },
  {
    name: "neon_rainbow_prisma",
    instruction:
      "Neon rainbow Prisma-style color segmentation across face and clothing. " +
      "Background: vibrant orange/pink gradient with abstract circular tech shapes. " +
      "High saturation, sharp edges, strong graphic color planes.",
  },
  {
    name: "three_quarter_lavender_mist",
    instruction:
      "Soft painterly-vector portrait. " +
      "Background: lavender/grey misty gradient with faint blurred shapes. " +
      "Maintain premium facial shading; subtle glow; calm tones.",
  },
  {
    name: "mono_teal_starry",
    instruction:
      "Monochrome/ink-like portrait rendering with strong tonal separation. " +
      "Background: teal night-sky gradient with tiny star-like dots and simple skyline hints. " +
      "Poster/print texture is acceptable but very subtle.",
  },
];

export const VARIANT_OUTFIT_GUIDANCE: string[] = [
  "Outfit vibe: premium techwear street style; futuristic jacket layering with subtle paneling and controlled neon seams; must suit the input person.",
  "Outfit vibe: minimal corporate-tech formal; clean tech blazer/shirt combo with subtle UI-line accents; must suit the input person.",
  "Outfit vibe: cinematic legacy-tech formal; elegant futuristic tailoring with muted metallic trims; must suit the input person.",
  "Outfit vibe: monochrome tactical-tech silhouette; structured coat/jacket with refined panel geometry; must suit the input person.",
  "Outfit vibe: executive tech portrait; premium futuristic business wear with precise seam detailing; must suit the input person.",
  "Outfit vibe: smart casual techwear; breathable futuristic outer layer with understated circuitry motifs; must suit the input person.",
  "Outfit vibe: cinematic high-tech jacket profile; contemporary techwear with subtle illuminated accents; must suit the input person.",
  "Outfit vibe: bold futuristic fashion-tech; stronger neon paneling while staying wearable and premium; must suit the input person.",
  "Outfit vibe: editorial soft-tech styling; classy futuristic fabric textures and clean panel transitions; must suit the input person.",
  "Outfit vibe: monochrome formal-tech tailoring; minimalist futuristic attire with strong tonal separation; must suit the input person.",
];

export const POSE_VARIATION_PRESETS: VariantPreset[] = [
  { name: "front_facing_neutral", instruction: "Front-facing neutral head-and-shoulders pose with minimal turn." },
  { name: "three_quarter_left", instruction: "Slight three-quarter view turned to the left." },
  { name: "three_quarter_right", instruction: "Slight three-quarter view turned to the right." },
  { name: "slight_head_tilt_left", instruction: "Subtle head tilt toward the left with natural eye line." },
  { name: "slight_head_tilt_right", instruction: "Subtle head tilt toward the right with natural eye line." },
  { name: "chin_slightly_up_confident", instruction: "Chin slightly up for a confident portrait angle." },
  { name: "chin_slightly_down_soft", instruction: "Chin slightly down for a softer portrait angle." },
  { name: "shoulders_angled_left", instruction: "Shoulders angled slightly left while keeping face identity consistent." },
  { name: "shoulders_angled_right", instruction: "Shoulders angled slightly right while keeping face identity consistent." },
  { name: "closer_crop_headshot", instruction: "Slightly closer headshot crop while staying head-and-shoulders." },
];

export const TECH_STYLE_BLOCK =
  "TECH STYLE (MANDATORY): futuristic tech-inspired avatar aesthetic with clean structured vector finish; " +
  "background must use abstract tech graphics only (HUD rings, subtle circuit traces, UI glow, geometric light panels, particles) " +
  "with NO realistic scenery; keep output clean and uncluttered.";

export const GENDER_ADAPTIVE_STYLE_BLOCK =
  "INPUT-ADAPTIVE STYLING (MANDATORY): infer gender presentation and age vibe from the input photo and keep that presentation consistent. " +
  "Select techwear outfit cuts/details appropriate to the same person; do not force masculine/feminine traits not present in the input.";

export const BOARDING_PASS_COLOR_BLOCK =
  "COLOR RULE (MANDATORY): adapt background and accent colors to harmonize with a red boarding-pass theme; " +
  "do not restrict to blue-only tones.";

const buildDefaultVectorizePrompt = (): string =>
  "Avatar Conversion (Image-to-Image AI Step)\n" +
  "Use the uploaded student photo as the reference image.\n\n" +
  "IDENTITY PRESERVATION (CRITICAL):\n" +
  "- Preserve 100% facial identity.\n" +
  "- Maintain exact face shape, jawline, cheekbones, nose, lips, and eye spacing.\n" +
  "- Keep hairstyle, hairline, and facial hair accurate.\n" +
  "- The student must remain clearly recognizable.\n\n" +
  "STYLE DIRECTION:\n" +
  "- Futuristic tech-inspired digital avatar.\n" +
  "- Clean structured vector illustration.\n" +
  "- Slightly enhanced symmetry is allowed without altering identity.\n" +
  "- Modern, confident expression.\n\n" +
  "VISUAL STYLE:\n" +
  "- Flat vector design.\n" +
  "- Smooth solid fills.\n" +
  "- Clean sharp scalable edges.\n" +
  "- Minimal gradients.\n" +
  "- Controlled geometric shading.\n" +
  "- Subtle neon rim lighting.\n" +
  "- Consistent line weight.\n" +
  "- No photorealism.\n" +
  "- No painterly texture.\n" +
  "- No noise.\n\n" +
  "COLOR RULES:\n" +
  "- Adapt the background and accent colors to harmonize with a red boarding pass theme.\n" +
  "- Do not restrict to blue tones.\n\n" +
  "BACKGROUND:\n" +
  "- Minimal futuristic gradient or soft abstract tech backdrop.\n" +
  "- Clean and uncluttered.\n\n" +
  "OUTPUT:\n" +
  "- Output must be high-resolution and suitable for profile or app display.\n" +
  "- 1:1 square portrait, centered head-and-shoulders.";

export const VECTORIZE_PROMPT = CUSTOM_VECTORIZE_PROMPT || buildDefaultVectorizePrompt();

export const normalizeVariantIndex = (variantIndex: number): number => {
  if (variantIndex < 1) return 1;
  if (variantIndex > VARIANT_STYLE_PRESETS.length) return VARIANT_STYLE_PRESETS.length;
  return variantIndex;
};

export const getPosePreset = (variantIndex: number): VariantPreset => {
  return POSE_VARIATION_PRESETS[normalizeVariantIndex(variantIndex) - 1];
};

export const clampPromptForModel = (promptText: string, modelName: string): string => {
  if (modelName === "dall-e-2" && promptText.length > DALLE2_MAX_PROMPT_CHARS) {
    return promptText.slice(0, DALLE2_MAX_PROMPT_CHARS);
  }
  return promptText;
};

export const buildVariantPrompt = (args: {
  variantIndex: number;
  variantsCount: number;
  stylePromptOverride?: string;
  poseVariationEnabled?: boolean;
  poseStrength?: string;
  posePresetName?: string;
  posePresetInstruction?: string;
}): { normalizedIndex: number; variantName: string; promptText: string } => {
  const normalizedIndex = normalizeVariantIndex(args.variantIndex);
  const safeTotal = Math.max(1, args.variantsCount);
  const preset = VARIANT_STYLE_PRESETS[normalizedIndex - 1];
  const outfitHint = VARIANT_OUTFIT_GUIDANCE[normalizedIndex - 1];
  const override = (args.stylePromptOverride ?? "").trim();
  const basePrompt = override || VECTORIZE_PROMPT;

  let promptText =
    `${basePrompt} ` +
    `${TECH_STYLE_BLOCK} ` +
    `${GENDER_ADAPTIVE_STYLE_BLOCK} ` +
    `${BOARDING_PASS_COLOR_BLOCK} ` +
    "Identity lock for this variant: same exact person and facial geometry from the input. " +
    "Do NOT change face shape/jaw, eye shape or spacing, eyebrow shape, nose structure, lip shape, beard/mustache style, " +
    "hairline/hairstyle, expression, head angle, framing/crop, or pose. " +
    `Variant ${normalizedIndex}/${safeTotal} style profile: ${preset.name}. ` +
    `${preset.instruction} ` +
    "MANDATORY OUTFIT CHANGE: Change the outfit for this variant to a clear techwear/futuristic clothing style. " +
    "Outfit must be different across variants and must be appropriate for the input person (gender presentation, age vibe, body proportions). " +
    "Do NOT alter body shape, neck shape, pose, or framing; only change the clothing design/colors/patterns. " +
    "Clothing change must be clearly visible in the collar/neckline and upper torso area. " +
    `${outfitHint} ` +
    "Only allowed changes: illustration style + background graphics + clothing. Everything else must match the input.";

  if (args.poseVariationEnabled) {
    const strengthInstruction =
      args.poseStrength === "medium"
        ? "Pose strength: noticeable 3/4 + shoulder angle, but not extreme."
        : "Pose strength: very slight turn/tilt only.";
    const poseName = (args.posePresetName ?? "").trim() || "front_facing_neutral";
    const poseInstruction =
      (args.posePresetInstruction ?? "").trim() || "Front-facing neutral head-and-shoulders pose.";
    promptText +=
      " POSE VARIATION (NEW FEATURE): " +
      `For this variant, adjust pose/framing as: ${poseName}. ${poseInstruction} ` +
      `${strengthInstruction} ` +
      "Keep the same person; keep facial geometry identical; no face reshaping. " +
      "Head & shoulders only, square crop, centered. " +
      "Do not change hairstyle/beard shape; keep consistent.";
  }

  return { normalizedIndex, variantName: preset.name, promptText };
};

export const buildEditPrompt = (basePromptText: string, variantName?: string): string => {
  const variantClause = variantName ? `Apply variant profile: ${variantName}. ` : "";
  return (
    `${basePromptText} ` +
    "Edit the PROVIDED input image directly. " +
    "Preserve the exact same person identity and facial geometry. " +
    "Do NOT change face shape, eye spacing/shape, nose structure, lip shape, jawline, hairline, hairstyle, expression, head angle, framing, or pose. " +
    "Do NOT swap person. " +
    "Do NOT make beauty edits, de-aging, face reshaping, or facial feature redesign. " +
    `${variantClause}` +
    "Only change visual style: vector/cartoon rendering, color blocks, gradients, contour lines, and simplified background."
  );
};

export const buildGenerationPromptFromReference = (args: {
  identityDescription: string;
  basePromptText: string;
  variantName?: string;
  poseVariationClause?: string | null;
  techStyleEnabled?: boolean;
}): string => {
  const identityClause = args.identityDescription
    ? `Reference identity details: ${args.identityDescription}. `
    : "Reference identity details are from the provided input portrait. ";
  const variantClause = args.variantName ? `Apply variant profile: ${args.variantName}. ` : "";
  const poseLine = !args.poseVariationClause
    ? "Pose/framing guidance: preserve expression and framing from the input reference. "
    : "Pose/framing guidance: controlled pose variation is allowed for this variant while identity remains fixed. " +
      `${args.poseVariationClause} `;
  const techLine = args.techStyleEnabled ? `${TECH_STYLE_BLOCK} ` : "";
  const adaptiveStyleLine = args.techStyleEnabled ? `${GENDER_ADAPTIVE_STYLE_BLOCK} ` : "";
  const colorRuleLine = args.techStyleEnabled ? `${BOARDING_PASS_COLOR_BLOCK} ` : "";

  return (
    `${args.basePromptText} ` +
    "Create a NEW stylized portrait image based on the reference identity. " +
    "Identity is the highest priority. " +
    "Do NOT change facial proportions. " +
    "Do NOT change person, age, ethnicity, gender. " +
    "Keep the same exact facial geometry. " +
    "Preserve face shape, jawline, eye shape/spacing, eyebrows, nose structure, lip shape, beard/mustache style, hairline, and hairstyle. " +
    `${poseLine}` +
    `${techLine}` +
    `${adaptiveStyleLine}` +
    `${colorRuleLine}` +
    "Only style may vary: color palette, shading, contour/line weight, and background aesthetics. " +
    `${variantClause}` +
    `${identityClause}` +
    "Output must remain the same person across all variants."
  );
};
