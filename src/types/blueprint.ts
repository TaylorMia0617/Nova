export type BlueprintNodeKind = "story" | "character" | "custom";
export type BlueprintStoryType = "start" | "ending" | "custom";
export type BlueprintFieldInputMode = "fixed" | "repeatable";
export type BlueprintPresetType =
  | "hook"
  | "linearPlot"
  | "nonlinearPlot"
  | "trickPerspective"
  | "trickTime"
  | "branchPlot"
  | "hiddenLine"
  | "chapter"
  | "mount"
  | "loop"
  | "logicBlock";
export type BlueprintNodeLayer = "story" | "structure" | "logic" | "control" | "narrative";
export type BlueprintStoryNodeType =
  | "hook"
  | "linearPlot"
  | "nonlinearPlot"
  | "trickPerspective"
  | "trickTime"
  | "branchPlot"
  | "hiddenLine";
export type BlueprintStructureNodeType = "chapter" | "chapterGroup" | "volume" | "act" | "mount";
export type BlueprintLogicNodeType = "logicBlueprint" | "because" | "and" | "or" | "compare" | "condition";
export type BlueprintControlNodeType = "loop" | "branch" | "merge";
export type BlueprintNarrativeNodeType = "conflict" | "foreshadow" | "reveal" | "twist";
export type BlueprintTypedNodeType =
  | BlueprintStoryNodeType
  | BlueprintStructureNodeType
  | BlueprintLogicNodeType
  | BlueprintControlNodeType
  | BlueprintNarrativeNodeType
  | "character"
  | "custom";
export type BlueprintEdgeRole = "flow" | "mount" | "logic" | "reveal" | "branch" | "merge";
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

export type BlueprintLogicConditionOperator = "and" | "or" | "equals" | "notEquals";
export type BlueprintLogicCompareOperator = "equals" | "notEquals" | "greaterThan" | "lessThan";

export type BlueprintLogicCondition = {
  id: string;
  value: string;
  operator?: BlueprintLogicConditionOperator;
};

export type BlueprintLogicBlock = {
  conditions: BlueprintLogicCondition[];
  result: string;
  therefore?: string;
};

export type BlueprintMountLink = {
  id: string;
  label: string;
  blueprintId: string;
  blueprintName: string;
  kind?: "mount" | "loop";
};

export type BlueprintLogicTree =
  | {
      id: string;
      type: "condition";
      text: string;
    }
  | {
      id: string;
      type: "group";
      operator: "and" | "or";
      children: BlueprintLogicTree[];
    }
  | {
      id: string;
      type: "compare";
      left: string;
      operator: BlueprintLogicCompareOperator;
      right: string;
    };

export type BlueprintTypedData = {
  summary?: string;
  content?: string;
  curiosity?: string;
  timelineMode?: string;
  perspectiveMode?: string;
  hiddenUntil?: string;
  chapterTitle?: string;
  parentStructureId?: string;
  mountKind?: string;
  loopMode?: "count" | "condition" | "infinite";
  loopCount?: number;
  loopUntil?: string;
  childBlueprint?: BlueprintDocument;
  mountLinks?: BlueprintMountLink[];
  timelineItems?: Array<{ id: string; time: string; event: string }>;
  relatedCharacters?: string[];
  conflictPoint?: string;
  protagonists?: string[];
  antagonists?: string[];
  loopSteps?: string[];
  logicTree?: BlueprintLogicTree;
  result?: string;
  therefore?: string;
  conflictGoal?: string;
  conflictObstacle?: string;
  setup?: string;
  payoff?: string;
  revealContent?: string;
  twistBefore?: string;
  twistAfter?: string;
  [key: string]: unknown;
};

export type BlueprintNode = {
  id: string;
  kind: BlueprintNodeKind;
  layer?: BlueprintNodeLayer;
  nodeType?: BlueprintTypedNodeType;
  typedData?: BlueprintTypedData;
  presetType?: BlueprintPresetType;
  parentChapterId?: string;
  parentStructureId?: string;
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
  logicBlock?: BlueprintLogicBlock;
};

export type BlueprintEdge = {
  id: string;
  from: string;
  to: string;
  role?: BlueprintEdgeRole;
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
