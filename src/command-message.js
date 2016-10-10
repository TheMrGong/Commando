const discord = require('discord.js');
const stripIndents = require('common-tags').stripIndents;
const FriendlyError = require('./errors/friendly');

/** A container for a message that triggers a command, that command, and methods to respond */
module.exports = class CommandMessage {
	/**
	 * @param {Message} message - Message that triggers the command
	 * @param {Command} command - Command the message triggers
	 * @param {string} argString - Argument string for the command
	 * @param {?Array<string>} patternMatches - Command pattern matches (if from a pattern trigger)
	 */
	constructor(message, command, argString = null, patternMatches = null) {
		/**
		 * Client that the message was sent from
		 * @type {CommandoClient}
		 */
		this.client = message.client;

		/**
		 * Message that triggers the command
		 * @type {Message}
		 */
		this.message = message;

		/**
		 * Command that the message triggers
		 * @type {Command}
		 */
		this.command = command;

		/**
		 * Argument string for the command
		 * @type {?string}
		 */
		this.argString = argString;

		/**
		 * Pattern matches (if from a pattern trigger)
		 * @type {?string[]}
		 */
		this.patternMatches = patternMatches;

		/**
		 * Response messages sent (set by the dispatcher after running the command)
		 * @type {?Message[]}
		 */
		this.responses = null;

		/**
		 * The index of the current response that will be edited
		 * @type {number}
		 */
		this.responseIndex = -1;
	}

	commandUsage(argString, onlyMention = false) {
		return this.command.usage(argString, this.message.guild, onlyMention);
	}

	parseArgs() {
		switch(this.command.argsType) {
			case 'single':
				return this.argString.trim().replace(this.argsSingleQuotes ? /^("|')([^]*)\1$/g : /^(")([^]*)"$/g, '$2');
			case 'multiple':
				return this.constructor.parseArgs(this.argString, this.argsCount, this.argsSingleQuotes);
			default:
				throw new RangeError(`Unknown argsType "${this.argsType}".`);
		}
	}

	async run() {
		// Make sure the command is usable
		if(this.command.guildOnly && !this.message.guild) {
			this.client.emit('commandBlocked', 'guildOnly');
			return await this.reply(`The \`${this.command.name}\` command must be used in a server channel.`);
		}
		if(!this.command.hasPermission(this)) {
			this.client.emit('commandBlocked', 'permission');
			return await this.reply(`You do not have permission to use the \`${this.command.name}\` command.`);
		}

		// Run the command
		const args = this.patternMatches || this.parseArgs();
		const fromPattern = Boolean(this.patternMatches);
		const typingCount = this.message.channel.typingCount;
		try {
			const promise = this.command.run(this, args, fromPattern);
			this.client.emit('commandRun', this.command, promise, this, args, fromPattern);
			return await promise;
		} catch(err) {
			this.client.emit('commandError', this.command, err, this, args, fromPattern);
			if(this.message.channel.typingCount > typingCount) this.message.channel.stopTyping();
			if(err instanceof FriendlyError) {
				return await this.reply(err.message);
			} else {
				const owner = this.client.options.owner ? this.client.users.get(this.client.options.owner) : null;
				const ownerName = owner ? `${discord.escapeMarkdown(owner.username)}#${owner.discriminator}` : 'the bot owner';
				const invite = this.client.options.invite;
				return await this.reply(stripIndents`
					An error occurred while running the command: \`${err.name}: ${err.message}\`
					You shouldn't ever receive an error like this.
					Please contact ${ownerName}${invite ? ` in this server: ${invite}` : '.'}
				`);
			}
		}
	}

	respond({ type = 'reply', content, options, lang }) {
		if(this.responses) {
			if(options && options.split && typeof options.split !== 'object') options.split = {};
			this.responseIndex++;
		}

		if(type === 'reply' && this.message.channel.type === 'dm') type = 'plain';
		if(type !== 'direct') {
			if(!this.message.channel.permissionsFor(this.client.user).hasPermission('SEND_MESSAGES')) {
				type = 'direct';
			}
		}

		content = this.client.resolver.resolveString(content);

		switch(type) {
			case 'plain':
				if(!this.responses) return this.message.channel.sendMessage(content, options);
				return this.editResponse(this.responses[this.responseIndex], { type, content, options });
			case 'reply':
				if(!this.responses) return this.message.reply(content, options);
				if(options && options.split && !options.split.prepend) options.split.prepend = `${this.message.author}, `;
				return this.editResponse(this.responses[this.responseIndex], { type, content, options });
			case 'direct':
				if(!this.responses) return this.message.author.sendMessage(content, options);
				return this.editResponse(this.responses[this.responseIndex], { type, content, options });
			case 'code':
				if(!this.responses) return this.message.channel.sendCode(lang, content, options);
				if(options && options.split) {
					if(!options.split.prepend) options.split.prepend = `\`\`\`${lang ? lang : ''}\n`;
					if(!options.split.append) options.split.append = '\n```';
				}
				content = discord.escapeMarkdown(content, true);
				return this.editResponse(this.responses[this.responseIndex], { type, content, options });
			default:
				throw new RangeError(`Unknown response type "${type}".`);
		}
	}

	editResponse(response, { type, content, options }) {
		if(!response) throw new Error('hmm');
		if(options && options.split) content = discord.splitMessage(content, options.split);

		let prepend = '';
		if(type === 'reply') prepend = `${this.message.author}, `;

		if(content instanceof Array) {
			const promises = [];
			if(response instanceof Array) {
				for(let i = 0; i < content.length; i++) {
					if(response.length > i) promises.push(response[i].edit(`${prepend}${content[i]}`));
					else promises.push(response[0].channel.sendMessage(`${prepend}${content[i]}`));
				}
			} else {
				promises.push(response.edit(`${prepend}${content[0]}`));
				for(let i = 1; i < content.length; i++) {
					promises.push(response.channel.sendMessage(`${prepend}${content[i]}`));
				}
			}
			return promises;
		} else {
			if(response instanceof Array) { // eslint-disable-line no-lonely-if
				for(let i = response.length - 1; i > 0; i--) response[i].delete();
				return response[0].edit(`${prepend}${content}`);
			} else {
				return response.edit(`${prepend}${content}`);
			}
		}
	}

	say(content, options) {
		return this.respond({ type: 'plain', content, options });
	}

	reply(content, options) {
		return this.respond({ type: 'reply', content, options });
	}

	direct(content, options) {
		return this.respond({ type: 'direct', content, options });
	}

	code(lang, content, options) {
		return this.respond({ type: 'code', content, options, lang });
	}

	_finalize(responses) {
		if(this.responses) {
			for(let i = this.responseIndex + 1; i < this.responses.length; i++) {
				const response = this.responses[i];
				if(response instanceof Array) {
					for(const resp of response) resp.delete();
				} else {
					response.delete();
				}
			}
		}

		this.responses = !responses || responses instanceof Array ? responses : [responses];
		this.responseIndex = -1;
	}

	/**
	 * Parses an argument string into an array of arguments
	 * @param {string} argString - The argument string to parse
	 * @param {number} [argCount] - The number of arguments to extract from the string
	 * @param {boolean} [allowSingleQuote=true] - Whether or not single quotes should be allowed to wrap arguments,
	 * in addition to double quotes
	 * @return {string[]} The array of arguments
	 */
	static parseArgs(argString, argCount, allowSingleQuote = true) {
		const re = allowSingleQuote ? /\s*(?:("|')([^]*?)\1|(\S+))\s*/g : /\s*(?:(")([^]*?)"|(\S+))\s*/g;
		const result = [];
		let match = [];
		// default: large enough to get all items
		argCount = argCount || argString.length;
		// get match and push the capture group that is not null to the result
		while(--argCount && (match = re.exec(argString))) result.push(match[2] || match[3]);
		// if text remains, push it to the array as it is, except for wrapping quotes, which are removed from it
		if(match && re.lastIndex < argString.length) {
			const re2 = allowSingleQuote ? /^("|')([^]*)\1$/g : /^(")([^]*)"$/g;
			result.push(argString.substr(re.lastIndex).replace(re2, '$2'));
		}
		return result;
	}


	/* -------------------------------------------------------------------------------------------- *\
	|*                                          SHORTCUTS                                           *|
	|*                          Rest not, and beware, for here be dragons.                          *|
	|* Below these lines lie the fabled message method/getter shortcuts for ye olde lazy developer. *|
	\* -------------------------------------------------------------------------------------------- */

	/**
	 * Shortcut to `this.message.id`
	 * @return {string}
	 */
	get id() {
		return this.message.id;
	}

	/**
	 * Shortcut to `this.message.content`
	 * @return {string}
	 */
	get content() {
		return this.message.content;
	}

	/**
	 * Shortcut to `this.message.author`
	 * @return {User}
	 */
	get author() {
		return this.message.author;
	}

	/**
	 * Shortcut to `this.message.channel`
	 * @return {Channel}
	 */
	get channel() {
		return this.message.channel;
	}

	/**
	 * Shortcut to `this.message.guild`
	 * @return {?Guild}
	 */
	get guild() {
		return this.message.guild;
	}

	/**
	 * Shortcut to `this.message.member`
	 * @return {?GuildMember}
	 */
	get member() {
		return this.message.member;
	}

	/**
	 * Shortcut to `this.message.pinned`
	 * @return {boolean}
	 */
	get pinned() {
		return this.message.pinned;
	}

	/**
	 * Shortcut to `this.message.tts`
	 * @return {boolean}
	 */
	get tts() {
		return this.message.tts;
	}

	/**
	 * Shortcut to `this.message.nonce`
	 * @return {string}
	 */
	get nonce() {
		return this.message.nonce;
	}

	/**
	 * Shortcut to `this.message.system`
	 * @return {boolean}
	 */
	get system() {
		return this.message.system;
	}

	/**
	 * Shortcut to `this.message.embeds`
	 * @return {Embed[]}
	 */
	get embeds() {
		return this.message.embeds;
	}

	/**
	 * Shortcut to `this.message.attachments`
	 * @return {Collection<string, MessageAttachment>}
	 */
	get attachments() {
		return this.message.attachments;
	}

	/**
	 * Shortcut to `this.message.createdTimestamp`
	 * @return {number}
	 */
	get createdTimestamp() {
		return this.message.createdTimestamp;
	}

	/**
	 * Shortcut to `this.message.createdAt`
	 * @return {Date}
	 */
	get createdAt() {
		return this.message.createdAt;
	}

	/**
	 * Shortcut to `this.message.editedTimestamp`
	 * @return {number}
	 */
	get editedTimestamp() {
		return this.message.editedTimestamp;
	}

	/**
	 * Shortcut to `this.message.editedAt`
	 * @return {Date}
	 */
	get editedAt() {
		return this.message.editedAt;
	}

	/**
	 * Shortcut to `this.message.mentions`
	 * @return {MentionsObject}
	 */
	get mentions() {
		return this.message.mentions;
	}

	/**
	 * Shortcut to `this.message.cleanContent`
	 * @return {string}
	 */
	get cleanContent() {
		return this.message.cleanContent;
	}

	/**
	 * Shortcut to `this.message.edits`
	 * @return {Message[]}
	 */
	get edits() {
		return this.message.edits;
	}

	/**
	 * Shortcut to `this.message.editable`
	 * @return {boolean}
	 */
	get editable() {
		return this.message.editable;
	}

	/**
	 * Shortcut to `this.message.deletable`
	 * @return {boolean}
	 */
	get deletable() {
		return this.message.deletable;
	}

	/**
	 * Shortcut to `this.message.pinnable`
	 * @return {boolean}
	 */
	get pinnable() {
		return this.message.pinnable;
	}

	/**
	 * Shortcut to `this.message.isMentioned(data)`
	 * @param {GuildChannel|User|Role|string} data - A guild channel, user, or a role, or the ID of any of these
	 * @return {boolean}
	 */
	isMentioned(data) {
		return this.message.isMentioned(data);
	}

	/**
	 * Shortcut to `this.message.edit(content)`
	 * @param {StringResolvable} content - New content for the message
	 * @returns {Promise<Message>}
	 */
	edit(content) {
		return this.message.edit(content);
	}

	/**
	 * Shortcut to `this.message.editCode(content)`
	 * @param {string} lang - Language for the code block
	 * @param {StringResolvable} content - New content for the message
	 * @returns {Promise<Message>}
	 */
	editCode(lang, content) {
		return this.message.editCode(lang, content);
	}

	/**
	 * Shortcut to `this.message.pin()`
	 * @returns {Promise<Message>}
	 */
	pin() {
		return this.message.pin();
	}

	/**
	 * Shortcut to `this.message.unpin()`
	 * @returns {Promise<Message>}
	 */
	unpin() {
		return this.message.unpin();
	}

	/**
	 * Shortcut to `this.message.delete()`
	 * @param {number} [timeout=0] - How long to wait to delete the message in milliseconds
	 * @returns {Promise<Message>}
	 */
	delete(timeout) {
		return this.message.delete(timeout);
	}
};
