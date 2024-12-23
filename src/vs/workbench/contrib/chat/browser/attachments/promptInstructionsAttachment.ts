/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { ResourceLabels } from '../../../../browser/labels.js';
import { ResourceContextKey } from '../../../../common/contextkeys.js';
import { ChatPromptInstructionAttachmentsModel, ChatPromptInstructionsAttachment } from '../chatAttachmentModel.js';

/**
 * TODO: @legomushroom - list
 *
 *  - make the prompt instructions attachment persistent
 *  - try different orders of prompt snippet inputs
 */

/**
 * Configuration setting name for the prompt instructions feature.
 */
export const PROMPT_INSTRUCTIONS_SETTING_NAME = 'chat.experimental.prompt-instructions.enabled';

/**
 * Configuration setting name for the prompt instructions source folder paths.
 */
const PROMPT_FILES_LOCATION_SETTING_NAME = 'chat.experimental.prompt-files.location';

/**
 * Default prompt instructions source folder paths.
 * TODO: @legomushroom - support glob patterns
 */
const PROMPT_FILES_DEFAULT_LOCATION = ['.copilot/prompts'];

/**
 * Extension of the prompt instructions files.
 * * TODO: @legomushroom - support glob patterns
 */
const INSTRUCTIONS_FILE_EXTENSION = '.md';

export class PromptInstructionsFileReader {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configService: IConfigurationService,
	) { }

	public async listFiles(): Promise<readonly URI[]> {
		const locations = this.getSourceLocations();
		const result = await this.findInstructionsFiles(locations);

		return result;
	}

	private getSourceLocations(): readonly URI[] {
		const state = this.workspaceService.getWorkbenchState();

		if (state === WorkbenchState.EMPTY) {
			return [];
		}

		const result = [];
		const { folders } = this.workspaceService.getWorkspace();
		for (const folder of folders) {
			for (const folderName of this.getSourceLocationsConfigValue()) {
				const folderUri = URI.joinPath(folder.uri, folderName);
				result.push(folderUri);
			}
		}

		return result;
	}

	private getSourceLocationsConfigValue(): readonly string[] {
		const value = this.configService.getValue(PROMPT_FILES_LOCATION_SETTING_NAME);

		if (value === undefined || value === null) {
			return PROMPT_FILES_DEFAULT_LOCATION;
		}

		if (typeof value === 'string') {
			return [value];
		}

		if (!Array.isArray(value)) {
			return [];
		}

		const result = value.filter((item) => {
			return typeof item === 'string';
		});

		return result;
	}

	private async findInstructionsFiles(
		locations: readonly URI[],
	): Promise<readonly URI[]> {
		const results = await this.fileService.resolveAll(
			locations.map((location) => {
				return { resource: location };
			}),
		);

		const files = [];
		for (const result of results) {
			const { stat, success } = result;

			if (!success) {
				continue;
			}

			if (!stat || !stat.children) {
				continue;
			}

			for (const child of stat.children) {
				const { name, resource, isDirectory } = child;

				// TODO: @legomushroom - filter out `symlinks` too?
				if (isDirectory) {
					continue;
				}

				if (!name.endsWith(INSTRUCTIONS_FILE_EXTENSION)) {
					continue;
				}

				files.push(resource);
			}
		}

		return files;

	}
}

export class PromptInstructionsAttachmentsWidget extends Disposable {
	public readonly domNode: HTMLElement;

	private children: PromptInstructionsAttachmentWidget[] = [];

	public get references(): readonly URI[] {
		const result = [];

		for (const child of this.children) {
			result.push(...child.references);
		}

		return result;
	}

	public get empty(): boolean {
		return this.children.length === 0;
	}

	constructor(
		private readonly model: ChatPromptInstructionAttachmentsModel,
		private readonly resourceLabels: ResourceLabels,
		@IInstantiationService private readonly initService: IInstantiationService,
	) {
		super();

		this.render = this.render.bind(this);
		this.domNode = dom.$('.chat-prompt-instructions-attachments');

		this._register(this.model.onUpdate(this.render));

		this.model.onAdd((attachment) => {
			const widget = this.initService.createInstance(
				PromptInstructionsAttachmentWidget,
				attachment,
				this.resourceLabels,
			).onDispose(() => {
				this.domNode.removeChild(widget.domNode);

				// TODO: @legomushroom - trace an error if the widget is not found
				this.children = this.children.filter((child) => {
					return child !== widget;
				});

				this.render();
			});

			this.children.push(widget);
			this.domNode.appendChild(widget.domNode);
			this.render();
		});
	}

	private render() {
		dom.setVisibility(!this.empty, this.domNode);
	}

	public override dispose(): void {
		for (const child of this.children) {
			child.dispose();
		}

		super.dispose();
	}
}

/**
 * Widget for a single prompt instructions attachment.
 */
export class PromptInstructionsAttachmentWidget extends Disposable {
	public readonly domNode: HTMLElement;

	/**
	 * Get `URI` for the main reference and `URI`s of all valid
	 * child references it may contain.
	 */
	public get references(): readonly URI[] {
		const { reference, enabled } = this.model;

		// return no references if the attachment is disabled
		if (!enabled) {
			return [];
		}

		// otherwise return `URI` for the main reference and
		// all valid child `URI` references it may contain
		return [
			...reference.validFileReferenceUris,
			reference.uri,
		];
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

	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly model: ChatPromptInstructionsAttachment,
		private readonly resourceLabels: ResourceLabels,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILabelService private readonly labelService: ILabelService,
		@IMenuService private readonly menuService: IMenuService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IModelService private readonly modelService: IModelService,
	) {
		super();

		this.render = this.render.bind(this);
		this.dispose = this.dispose.bind(this);
		this.domNode = dom.$('.chat-prompt-instructions-attachment.chat-attached-context-attachment.show-file-icons.implicit');

		this.model.onUpdate(this.render);
		this.model.onDispose(this.dispose);

		this.render();
	}

	// TODO: @legomushroom - render only once?
	private render() {
		dom.clearNode(this.domNode);
		this.renderDisposables.clear();

		const { enabled, errorCondition } = this.model;

		this.domNode.classList.toggle('disabled', !enabled);

		this.domNode.classList.remove('warning');
		this.domNode.classList.remove('error');

		const label = this.resourceLabels.create(this.domNode, { supportIcons: true });
		const file = this.model.reference.uri;

		const fileBasename = basename(file);
		const fileDirname = dirname(file);
		const friendlyName = `${fileBasename} ${fileDirname}`;
		const ariaLabel = localize('chat.instructionsAttachment', "Prompt instructions attachment, {0}", friendlyName);

		const uriLabel = this.labelService.getUriLabel(file, { relative: true });
		const currentFile = localize('openEditor', "Prompt instructions");
		const inactive = localize('enableHint', "disabled");
		const currentFileHint = currentFile + (enabled ? '' : ` (${inactive})`);

		const title = `${currentFileHint} ${uriLabel}`;
		label.setFile(file, {
			fileKind: FileKind.FILE,
			hidePath: true,
			range: undefined,
			title,
			icon: ThemeIcon.fromId(Codicon.lightbulbSparkle.id),
			extraClasses: [],
		});
		this.domNode.ariaLabel = ariaLabel;
		this.domNode.tabIndex = 0;

		let hoverTitle = title;
		if (errorCondition) {
			const { type, details } = errorCondition;
			this.domNode.classList.add(type);

			const errorCaption = type === 'warning'
				? localize('warning', "[Warning]")
				: localize('error', "[Error]");

			hoverTitle += `\n-\n${errorCaption}: ${details}`;
		}

		const hintElement = dom.append(this.domNode, dom.$('span.chat-implicit-hint', undefined, 'Instructions'));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), hintElement, hoverTitle));

		// TODO: @legomushroom - update localization keys below
		const toggleButtonMsg = enabled ? localize('disable1', "Disable") : localize('enable1', "Enable");
		this.domNode.ariaLabel = toggleButtonMsg; // TODO: @legomushroom - correct the aria lable
		const toggleButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: toggleButtonMsg }));
		toggleButton.icon = enabled ? Codicon.eye : Codicon.eyeClosed;
		this.renderDisposables.add(toggleButton.onDidClick((e) => {
			e.stopPropagation();
			this.model.toggle();
		}));

		const removeButton = this.renderDisposables.add(new Button(this.domNode, { supportIcons: true, title: localize('remove', "Remove") }));
		removeButton.icon = Codicon.x;
		this.renderDisposables.add(removeButton.onDidClick((e) => {
			e.stopPropagation();
			this.model.dispose();
		}));

		// Context menu
		const scopedContextKeyService = this.renderDisposables.add(this.contextKeyService.createScoped(this.domNode));

		const resourceContextKey = this.renderDisposables.add(new ResourceContextKey(scopedContextKeyService, this.fileService, this.languageService, this.modelService));
		resourceContextKey.set(file);

		this.renderDisposables.add(dom.addDisposableListener(this.domNode, dom.EventType.CONTEXT_MENU, async domEvent => {
			const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
			dom.EventHelper.stop(domEvent, true);

			this.contextMenuService.showContextMenu({
				contextKeyService: scopedContextKeyService,
				getAnchor: () => event,
				getActions: () => {
					const menu = this.menuService.getMenuActions(MenuId.ChatInputResourceAttachmentContext, scopedContextKeyService, { arg: file });
					return getFlatContextMenuActions(menu);
				},
			});
		}));
	}

	public override dispose(): void {
		this._onDispose.fire();

		super.dispose();
	}
}
