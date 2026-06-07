export type BlueprintNodeKind = "story" | "character" | "custom";
export type BlueprintStoryType = "start" | "ending" | "custom";
export type BlueprintFieldInputMode = "fixed" | "repeatable";
export type BlueprintFieldBindingKey =
  | "custom"
  | "title"
  | "summary"
  | "linkedChapters"
  | "storyType"
  | "storyEventContent"
  | "storyEventTime"
  | "storyEventForeshadowing"
  | "characterName"
  | "identity"
  | "relationshipTarget"
  | "relationshipDescription"
  | "characterEventTime"
  | "characterEventStory"
  | "characterEventLocation";

export type BlueprintRelationship = {
  id: string;
  target: string;
  description: string;
  relation?: string;
  name?: string;
  identity?: string;
};

export type BlueprintCharacterEvent = {
  id: string;
  time: string;
  story: string;
  location: string;
};

export type BlueprintCustomField = {
  id: string;
  key: string;
  value: string;
  values?: string[];
  inputMode?: BlueprintFieldInputMode;
  bindingKey?: BlueprintFieldBindingKey;
  showInCard?: boolean;
};

export type BlueprintNode = {
  id: string;
  kind: BlueprintNodeKind;
  x: number;
  y: number;
  title: string;
  storyType?: BlueprintStoryType;
  summary?: string;
  linkedChapters?: string[];
  storyEvents?: Array<{
    id: string;
    time: string;
    content: string;
    foreshadowing: string;
  }>;
  characterName?: string;
  identity?: string;
  characterEvents?: BlueprintCharacterEvent[];
  relationships?: BlueprintRelationship[];
  templateName?: string;
  inputCount?: number;
  linkedChapter?: string;
  time?: string;
  foreshadowing?: string;
  keywords?: string[];
  relationship?: string;
  customFields?: BlueprintCustomField[];
};

export type BlueprintEdge = {
  id: string;
  from: string;
  to: string;
};

export type BlueprintDocument = {
  id: string;
  name: string;
  updatedAt: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
};

export type BlueprintNodeTemplate = {
  id: string;
  name: string;
  nodeKind: BlueprintNodeKind;
  inputCount: number;
  fields: Array<{
    id: string;
    key: string;
    defaultValue: string;
    defaultValues?: string[];
    inputMode?: BlueprintFieldInputMode;
    bindingKey?: BlueprintFieldBindingKey;
    showInCard?: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
};
