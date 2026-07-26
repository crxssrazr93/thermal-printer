import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CharacterCount from '@tiptap/extension-character-count';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';

// Only what the app actually wires up. The menu extensions were dropped when
// the bubble menu was: they expect a positioning library that is not shipped
// here, and the app positions its own. Alignment is carried by the markdown
// table syntax rather than by a mark, so TextAlign has nothing to do either.
window.TipTap = {
  Editor, StarterKit, Table, TableRow, TableCell, TableHeader, Image, Link,
  TaskList, TaskItem, CharacterCount, Placeholder,
  Mention, Underline, Highlight, Subscript, Superscript,
};
