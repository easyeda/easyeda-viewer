import type { Shell, Theme, ChromeFlags } from './shell';

export type AnnotationGroup = 'schematic' | 'pcb';
export type AnnotationStatus = 'pending' | 'resolved';
export interface AnnotationUser { id: string; name: string }
export interface AnnotationDocument {
  id: string;
  nodeId: string;
  group: AnnotationGroup;
  title: string;
}
export type AnnotationShape =
  | { type: 'text'; geometry: { x: number; y: number } }
  | { type: 'rectangle' | 'circle'; geometry: { x: number; y: number; width: number; height: number } };
export interface AnnotationReply {
  id: string;
  text: string;
  creator: AnnotationUser;
  createdAt: string;
}
export type Annotation = AnnotationShape & {
  id: string;
  documentId: string;
  group: AnnotationGroup;
  text: string;
  status: AnnotationStatus;
  creator: AnnotationUser;
  createdAt: string;
  updatedAt: string;
  replies: AnnotationReply[];
};
export interface AnnotationSnapshot {
  schemaVersion: 1;
  projectId: string;
  revision: string;
  documents: AnnotationDocument[];
  annotations: Annotation[];
}
export interface AnnotationContext {
  projectId: string;
  revision: string;
  documents: AnnotationDocument[];
  currentDocument: AnnotationDocument | null;
}
export interface AnnotationChange {
  reason: 'create' | 'update' | 'delete' | 'reply' | 'import' | 'undo' | 'redo';
  sequence: number;
  data: AnnotationSnapshot;
}
export interface AnnotationApi {
  readonly version: '1.2.0';
  loadProject(files: FileList | File[], options?: {
    projectId?: string; revision?: string; user?: AnnotationUser;
    annotations?: AnnotationSnapshot | string;
  }): Promise<AnnotationSnapshot>;
  getContext(): AnnotationContext;
  setUser(user: AnnotationUser): AnnotationUser;
  exportAnnotations(): AnnotationSnapshot;
  importAnnotations(data: AnnotationSnapshot | string): number;
  createAnnotation(input: AnnotationShape & { documentId?: string; text: string }): Annotation;
  updateAnnotation(id: string, patch: { text?: string; status?: AnnotationStatus }): Annotation;
  deleteAnnotation(id: string): void;
  addReply(id: string, content: string): AnnotationReply;
  focusAnnotation(id: string): Promise<void>;
  /** select + highlight a component by designator; opens a sibling sheet if needed */
  selectByDesignator(designator: string): Promise<boolean>;
  /** clear the current canvas selection */
  clearSelection(): void;
  open(nodeId: string): Promise<AnnotationContext>;
  undo(): boolean;
  redo(): boolean;
  onChange(callback: (event: AnnotationChange) => void): () => void;
  setAnnotationsVisible(value: boolean): boolean;
  getAnnotationsVisible(): boolean;
  fit(): void;
  setTheme(theme: Theme): void;
  setChrome(flags: Partial<ChromeFlags>): void;
}
export interface AnnotationController { api: AnnotationApi; destroy(): void }
export function installAnnotations(shell: Shell): AnnotationController;
declare global {
  interface Window { easyedaViewer: AnnotationApi }
}
