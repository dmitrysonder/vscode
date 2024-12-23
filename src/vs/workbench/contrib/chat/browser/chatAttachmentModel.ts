/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { assertDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatEditingService } from '../common/chatEditingService.js';
import { IChatRequestVariableEntry } from '../common/chatModel.js';
import { PromptFileReference, TErrorCondition } from '../common/promptFileReference.js';
import { FileOpenFailed, NonPromptSnippetFile, RecursiveReference } from '../common/promptFileReferenceErrors.js';
import { PromptInstructionsFileReader } from './attachments/promptInstructionsAttachment.js';

export interface IErrorCondition {
	type: 'error' | 'warning';
	details: string;
}

/**
 * Chat prompt instructions attachment.
 */
export class ChatPromptInstructionsAttachment extends Disposable {
	/**
	 * Private reference of the underlying prompt instructions
	 * reference instance.
	 */
	private readonly _reference: PromptFileReference;
	/**
	 * Get the prompt instructions reference instance.
	 */
	public get reference(): PromptFileReference {
		return this._reference;
	}

	/**
	 * If the prompt instructions reference has failed to resolve, this
	 * field error that contains failure details, otherwise `undefined`.
	 */
	public get errorCondition(): IErrorCondition | undefined {
		const { errorCondition } = this._reference;

		const errorConditions = this.collectErrorConditions();
		if (errorConditions.length === 0) {
			return undefined;
		}

		const [firstError, ...restErrors] = errorConditions;

		// if the first error is the error of the root reference,
		// then return it as an `error` otherwise use `warning`
		const isRootError = (firstError === errorCondition);
		const type = (isRootError)
			? 'error'
			: 'warning';

		const moreSuffix = restErrors.length > 0
			? `\n-\n +${restErrors.length} more error${restErrors.length > 1 ? 's' : ''}`
			: '';

		const errorMessage = this.getErrorMessage(firstError, isRootError);
		return {
			type,
			details: `${errorMessage}${moreSuffix}`,
		};
	}

	private getErrorMessage(
		error: TErrorCondition,
		isRootError: boolean,
	): string {
		const { uri } = error;

		const prefix = (!isRootError)
			? 'Contains a broken nested reference that will be ignored: '
			: '';

		if (error instanceof FileOpenFailed) {
			return `${prefix}Failed to open file '${uri.path}'.`;
		}

		if (error instanceof RecursiveReference) {
			const { recursivePath } = error;

			const recursivePathString = recursivePath
				.map((path) => {
					return basename(URI.file(path));
				})
				.join(' -> ');

			return `${prefix}Recursive reference found:\n${recursivePathString}`;
		}

		return `${prefix}${error.message}`;
	}

	private collectErrorConditions(): TErrorCondition[] {
		return this.reference
			// get all references (including the root) as a flat array
			.flatten()
			// filter out children without error conditions or
			// the ones that are non-prompt snippet files
			.filter((childReference) => {
				const { errorCondition } = childReference;

				return errorCondition && !(errorCondition instanceof NonPromptSnippetFile);
			})
			// map to error condition objects
			.map((childReference): TErrorCondition => {
				const { errorCondition } = childReference;

				// must always be true because of the filter call above
				assertDefined(
					errorCondition,
					`Error condition must be present for '${childReference.uri.path}'.`,
				);

				return errorCondition;
			});
	}

	/**
	 * Event that fires when the error condition of the prompt
	 * reference changes.
	 *
	 * See {@linkcode onUpdate}.
	 */
	protected _onUpdate = this._register(new Emitter<void>());
	/**
	 * Subscribe to the `onUpdate` event.
	 * @param callback Function to invoke on update.
	 */
	public onUpdate(callback: () => unknown): this {
		this._register(this._onUpdate.event(callback));

		return this;
	}

	/**
	 * Event that fires when the object is disposed.
	 *
	 * See {@linkcode onDispose}.
	 */
	protected _onDispose = this._register(new Emitter<void>());
	/**
	 * Subscribe to the `onDispose` event.
	 * @param callback Function to invoke on dispose.
	 */
	public onDispose(callback: () => unknown): this {
		this._register(this._onDispose.event(callback));

		return this;
	}

	/**
	 * Private property to track the `enabled` state of the prompt
	 * instructions attachment.
	 */
	private _enabled: boolean = true;
	/**
	 * Get the `enabled` state of the prompt instructions attachment.
	 */
	public get enabled(): boolean {
		return this._enabled;
	}

	// /**
	//  * State of the underlying prompt instructions reference resolve
	//  * operation.
	//  */
	// private _resolveFailed?: boolean;

	constructor(
		uri: URI,
		@IInstantiationService private readonly initService: IInstantiationService,
	) {
		super();

		this._reference = this.initService.createInstance(PromptFileReference, uri)
			.onUpdate(() => {
				this._onUpdate.fire();
				// TODO: @legomushroom - remove?
				// fire `onUpdate` event only if the error condtion has changed
				// if (this._resolveFailed !== this._reference.resolveFailed) {
				// 	this._resolveFailed = this._reference.resolveFailed;
				// }
			});

		this._register(this._reference);
	}

	/**
	 * Start resolving the prompt instructions reference and child references
	 * that it may contain.
	 */
	public resolve(): this {
		this._reference.resolve();

		return this;
	}

	/**
	 * Toggle the `enabled` state of the prompt instructions attachment.
	 */
	public toggle(): this {
		this._enabled = !this._enabled;
		this._onUpdate.fire();

		return this;
	}

	public override dispose(): void {
		this._onDispose.fire();

		super.dispose();
	}
}

export class ChatPromptInstructionAttachmentsModel extends Disposable {
	protected _onUpdate = this._register(new Emitter<void>());
	readonly onUpdate = this._onUpdate.event;

	protected _onAdd = this._register(new Emitter<ChatPromptInstructionsAttachment>());
	public onAdd(callback: (attachment: ChatPromptInstructionsAttachment) => unknown): this {
		this._register(this._onAdd.event(callback));

		return this;
	}

	private readonly instructionsFileReader: PromptInstructionsFileReader;

	private instructions: DisposableMap<string, ChatPromptInstructionsAttachment> =
		this._register(new DisposableMap());

	constructor(
		@IInstantiationService private readonly initService: IInstantiationService,
	) {
		super();

		this._onUpdate.fire = this._onUpdate.fire.bind(this._onUpdate);
		this.instructionsFileReader = initService.createInstance(PromptInstructionsFileReader);
	}

	/**
	 * Add a prompt instruction attachment instance with the provided `URI`.
	 * @param uri URI of the prompt instruction attachment to add.
	 */
	public add(uri: URI): this {
		// if already exists, nothing to do
		if (this.instructions.has(uri.path)) {
			return this;
		}

		const instruction = this.initService.createInstance(ChatPromptInstructionsAttachment, uri)
			.onUpdate(this._onUpdate.fire)
			.onDispose(() => {
				this.instructions.deleteAndDispose(uri.path);
			});

		this.instructions.set(uri.path, instruction);
		instruction.resolve();

		this._onAdd.fire(instruction);
		this._onUpdate.fire();

		return this;
	}

	/**
	 * Remove a prompt instruction attachment instance by provided `URI`.
	 * @param uri URI of the prompt instruction attachment to remove.
	 */
	public remove(uri: URI): this {
		// if does not exist, nothing to do
		if (!this.instructions.has(uri.path)) {
			return this;
		}

		this.instructions.deleteAndDispose(uri.path);
		this._onUpdate.fire();

		return this;
	}

	// /**
	//  * Toggle the `enabled` state of a prompt instruction attachment
	//  * identified by provided `URI`.
	//  * @param uri URI of the prompt instruction attachment to toggle.
	//  */
	// public toggle(uri: URI): this {
	// 	const attachment = this.instructions.get(uri.path);

	// 	assertDefined(
	// 		attachment,
	// 		`Attachment with for '${uri.path}' does not exist.`,
	// 	);

	// 	attachment.toggle();

	// 	return this;
	// }

	/**
	 * List all prompt instruction files available.
	 */
	public async listInstructionFiles(): Promise<readonly URI[]> {
		return await this.instructionsFileReader.listFiles();
	}
}

export class ChatAttachmentModel extends Disposable {
	/**
	 * Collection on prompt instruction attachments.
	 */
	public readonly promptInstructions = this._register(
		new ChatPromptInstructionAttachmentsModel(this.initService),
	);

	constructor(
		@IInstantiationService private readonly initService: IInstantiationService,
	) {
		super();

		this._register(
			this.promptInstructions.onUpdate(() => {
				this._onDidChangeContext.fire();
			}),
		);
	}

	private _attachments = new Map<string, IChatRequestVariableEntry>();
	get attachments(): ReadonlyArray<IChatRequestVariableEntry> {
		return Array.from(this._attachments.values());
	}

	protected _onDidChangeContext = this._register(new Emitter<void>());
	readonly onDidChangeContext = this._onDidChangeContext.event;

	get size(): number {
		return this._attachments.size;
	}

	getAttachmentIDs() {
		return new Set(this._attachments.keys());
	}

	clear(): void {
		this._attachments.clear();
		this._onDidChangeContext.fire();
	}

	delete(...variableEntryIds: string[]) {
		for (const variableEntryId of variableEntryIds) {
			this._attachments.delete(variableEntryId);
		}
		this._onDidChangeContext.fire();
	}

	addFile(uri: URI, range?: IRange) {
		this.addContext(this.asVariableEntry(uri, range));
	}

	asVariableEntry(uri: URI, range?: IRange): IChatRequestVariableEntry {
		return {
			value: range ? { uri, range } : uri,
			id: uri.toString() + (range?.toString() ?? ''),
			name: basename(uri),
			isFile: true,
			isDynamic: true
		};
	}

	addContext(...attachments: IChatRequestVariableEntry[]) {
		let hasAdded = false;

		for (const attachment of attachments) {
			if (!this._attachments.has(attachment.id)) {
				this._attachments.set(attachment.id, attachment);
				hasAdded = true;
			}
		}

		if (hasAdded) {
			this._onDidChangeContext.fire();
		}
	}

	// private readonly instructionsFileReader: PromptInstructionsFileReader;

	// public async listInstructionFiles(): Promise<readonly URI[]> {
	// 	return this.instructionsFileReader.listFiles();
	// }

	clearAndSetContext(...attachments: IChatRequestVariableEntry[]) {
		this.clear();
		this.addContext(...attachments);
	}

	// public override dispose(): void {
	// 	this._promptInstructions?.dispose();

	// 	super.dispose();
	// }

	// private _promptInstructions: PromptFileReference | undefined;
	// public get promptInstructions(): PromptFileReference | undefined {
	// 	return this._promptInstructions;
	// }

	/**
	 * Add a prompt instruction attachment for provided URI.
	 * @param uri URI of the prompt instruction attachment to add.
	 */
	public addPromptInstructions(uri: URI): this {
		this.promptInstructions.add(uri);

		return this;
	}

	/**
	 * Remove a prompt instruction attachment by provided URI.
	 * @param uri URI of the prompt instruction attachment to remove.
	 */
	public removePromptInstructions(uri: URI): this {
		this.promptInstructions.remove(uri);

		return this;
	}

	// /**
	//  * Toggle the `enabled` state of a prompt instruction attachment
	//  * identified by provided `URI`.
	//  * @param uri URI of the prompt instruction attachment to toggle.
	//  */
	// public togglePromptInstructions(uri: URI): this {
	// 	this.promptInstructions.toggle(uri);

	// 	return this;
	// }

	/**
	 * List all prompt instruction files available.
	 */
	public async listPromptInstructionFiles(): Promise<readonly URI[]> {
		return await this.promptInstructions.listInstructionFiles();
	}
}

export class EditsAttachmentModel extends ChatAttachmentModel {

	private _onFileLimitExceeded = this._register(new Emitter<void>());
	readonly onFileLimitExceeded = this._onFileLimitExceeded.event;

	get fileAttachments() {
		return this.attachments.filter(attachment => attachment.isFile);
	}

	private readonly _excludedFileAttachments: IChatRequestVariableEntry[] = [];
	get excludedFileAttachments(): IChatRequestVariableEntry[] {
		return this._excludedFileAttachments;
	}

	constructor(
		@IInstantiationService _initService: IInstantiationService,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
	) {
		super(_initService);
	}

	private isExcludeFileAttachment(fileAttachmentId: string) {
		return this._excludedFileAttachments.some(attachment => attachment.id === fileAttachmentId);
	}

	override addContext(...attachments: IChatRequestVariableEntry[]) {
		const currentAttachmentIds = this.getAttachmentIDs();
		const fileAttachments = attachments.filter(attachment => attachment.isFile);
		const otherAttachments = attachments.filter(attachment => !attachment.isFile);

		// deduplicate file attachments
		const newFileAttachments = [];
		const newFileAttachmentIds = new Set<string>();
		for (const attachment of fileAttachments) {
			if (newFileAttachmentIds.has(attachment.id) || currentAttachmentIds.has(attachment.id)) {
				continue;
			}
			newFileAttachmentIds.add(attachment.id);
			newFileAttachments.push(attachment);
		}

		const availableFileCount = Math.max(0, this._chatEditingService.editingSessionFileLimit - this.fileAttachments.length);
		const fileAttachmentsToBeAdded = newFileAttachments.slice(0, availableFileCount);

		if (newFileAttachments.length > availableFileCount) {
			const attachmentsExceedingSize = newFileAttachments.slice(availableFileCount).filter(attachment => !this.isExcludeFileAttachment(attachment.id));
			this._excludedFileAttachments.push(...attachmentsExceedingSize);
			this._onDidChangeContext.fire();
			this._onFileLimitExceeded.fire();
		}

		super.addContext(...otherAttachments, ...fileAttachmentsToBeAdded);
	}

	override clear(): void {
		this._excludedFileAttachments.splice(0, this._excludedFileAttachments.length);
		super.clear();
	}

	override delete(...variableEntryIds: string[]) {
		for (const variableEntryId of variableEntryIds) {
			const excludedFileIndex = this._excludedFileAttachments.findIndex(attachment => attachment.id === variableEntryId);
			if (excludedFileIndex !== -1) {
				this._excludedFileAttachments.splice(excludedFileIndex, 1);
			}
		}

		super.delete(...variableEntryIds);

		if (this.fileAttachments.length < this._chatEditingService.editingSessionFileLimit) {
			const availableFileCount = Math.max(0, this._chatEditingService.editingSessionFileLimit - this.fileAttachments.length);
			const reAddAttachments = this._excludedFileAttachments.splice(0, availableFileCount);
			super.addContext(...reAddAttachments);
		}
	}
}
