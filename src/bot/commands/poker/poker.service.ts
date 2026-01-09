import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Code, Repository } from 'typeorm';
import { PokerGame } from '../../models/poker.entity';
import { User } from '../../models/user.entity';
import { MezonClientService } from '../../../mezon/services/mezon-client.service';
import {
  EButtonMessageStyle,
  EMessageComponentType,
  EMarkdownType,
  MezonClient,
} from 'mezon-sdk';

export interface Player {
  id: string;
  name: string;
  chips: number;
  seat: number;
  hole: string[];
  hasFolded: boolean;
  currentBet: number;
  isAllIn: boolean; // Đánh dấu người chơi đã all-in thực sự
}

export interface Game {
  id: string;
  clanId: string;
  channelId: string;
  createdAt: Date;
  players: Player[];
  deck: string[];
  burned: string[];
  board: string[];
  pot: number;
  currentBet: number;
  round: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  dealerButton: number;
  currentPlayerIndex: number;
  isActive: boolean;
  hasRaiseInRound: boolean; // Track if anyone has raised in current round
  betAmount: number; // Amount of money each player bet to join the game

  lastAggressorIndex: number | null; // người raise/bet gần nhất trong round
  toActIds: string[]; // danh sách playerId còn phải hành động trước khi đóng round
  actionHistory: PlayerAction[]; // Lịch sử action của người chơi
}

export interface PlayerAction {
  playerId: string;
  playerName: string;
  action: 'bet' | 'call' | 'raise' | 'check' | 'fold' | 'allin';
  amount?: number;
  totalBet?: number;
  timestamp: Date;
  round: string;
}

export interface GameResult {
  success: boolean;
  message?: string;
  game?: Game;
  gameStarted?: boolean;
}

export interface PokerInvite {
  gameId: string;
  creatorId: string;
  clanId: string;
  channelId: string;
  messageId: string;
  mentionedUsers: { idUser: string; name: string }[];
  confirmedUsers: string[];
  declinedUsers: string[];
  expiresAt: Date;
  betAmount: number;
}

export interface InviteResult {
  success: boolean;
  gameId: string;
  message?: string;
}

export interface InviteResponsesSummary {
  joined: string[];
  declined: string[];
  pending: { idUser: string; name: string }[];
}

export interface ButtonActionResult {
  success: boolean;
  message: string;
  shouldUpdate?: boolean;
  gameStarted?: boolean;
}

@Injectable()
export class PokerService {
  private client: MezonClient;
  private activeGames: Map<string, Game> = new Map();
  private gameTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private gameInvites: Map<string, PokerInvite> = new Map();
  private inviteTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private playerTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Timeout cho từng người chơi
  private inviteUpdateIntervals: Map<string, NodeJS.Timeout> = new Map(); // Interval cập nhật invite message
  private turnTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private turnMessageIds: Map<string, string> = new Map(); // Lưu message ID của turn action
  private insufficientFundsTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Timeout cho người chơi không đủ tiền
  private insufficientFundsMessageIds: Map<string, string> = new Map(); // Lưu message ID của insufficient funds messages
  private continueGameTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Timeout cho continue game invitation
  private continueGameMessageIds: Map<string, string> = new Map(); // Lưu message ID của continue game invitation
  private continueGamePlayers: Map<string, Set<string>> = new Map(); // Lưu danh sách người chơi đã accept continue game
  private continueGameInfo: Map<string, any> = new Map(); // Lưu thông tin game để continue
  private newGameCreatedMessageIds: Map<string, string> = new Map(); // Lưu message ID thông báo "Game mới đã được tạo!"
  private newGameStartedMessageIds: Map<string, string> = new Map(); // Lưu message ID thông báo "Game mới đã bắt đầu!"
  private continueGamePaid: Map<string, Set<string>> = new Map(); // Lưu danh sách user đã bị trừ tiền khi bấm tham gia

  private readonly SUITS = ['♠️', '♥️', '♦️', '♣️'];
  private readonly RANKS = [
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    'J',
    'Q',
    'K',
    'A',
  ];
  private readonly DEAL_DELAY = 100; // 30 seconds
  private readonly INVITE_TIMEOUT = 30000; // 30 giây cho mỗi người chơi
  private readonly TURN_TIMEOUT = 30000; // 30 giây cho mỗi lượt
  private readonly REVEAL_DELAY_MS = 500; // 0.5s trước khi mở mỗi street (tối ưu performance)
  private readonly ENABLE_REVEAL_DELAY = false; // Tắt delay để tối ưu performance tối đa

  // Method để bật/tắt delay (có thể gọi từ config hoặc admin command)
  public setRevealDelay(enabled: boolean): void {
    (this as any).ENABLE_REVEAL_DELAY = enabled;
  }

  // Xóa thông tin continue game
  private cleanupContinueGameData(gameKey: string): void {
    // Xóa timeout
    const timeout = this.continueGameTimeouts.get(gameKey);
    if (timeout) {
      clearTimeout(timeout);
      this.continueGameTimeouts.delete(gameKey);
    }

    // Xóa message ID
    this.continueGameMessageIds.delete(gameKey);

    // Xóa danh sách người chơi
    this.continueGamePlayers.delete(gameKey);

    // Xóa thông tin game
    this.continueGameInfo.delete(gameKey);
  }

  // Hiển thị button để mời cả channel tiếp tục chơi ván mới
  private async sendContinueGameButtons(game: Game): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);

    this.continueGamePlayers.set(gameKey, new Set());
    this.continueGamePaid.set(gameKey, new Set());

    // Lưu thông tin game để sử dụng sau này (không cố định danh sách người chơi)
    const gameInfo = {
      clanId: game.clanId,
      channelId: game.channelId,
      gameId: game.id,
      // players giữ lại chỉ để tham chiếu, nhưng lời mời áp dụng cho cả channel
      players: game.players.filter((p) => !p.hasFolded),
      betAmount: game.betAmount,
    };

    // Lưu vào một Map để sử dụng sau này
    if (!this.continueGameInfo) {
      this.continueGameInfo = new Map();
    }
    this.continueGameInfo.set(gameKey, gameInfo);

    const buttons = [
      {
        id: `poker_continue_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '🔄 Tiếp tục chơi',
          style: EButtonMessageStyle.SUCCESS as any,
        },
      },
      {
        id: `poker_decline_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '❌ Từ chối',
          style: EButtonMessageStyle.DANGER as any,
        },
      },
    ];

    const components = [
      {
        components: buttons,
      },
    ];

    const messageContent =
      `🎉 **Ván poker đã kết thúc!**\n` +
      `🎰 **Mời mọi người trong kênh tiếp tục ván mới!**\n` +
      `💰 **Mức cược gợi ý:** ${game.betAmount.toLocaleString()} token\n` +
      `Nhấn "Tiếp tục chơi" để tham gia ván mới.\n` +
      `⏰ **15 giây** để đăng ký! (Tối thiểu 2, tối đa 8 người)`;

    const messageId = await this.sendChannelMessage(
      game.clanId,
      game.channelId,
      messageContent,
      components,
    );

    if (messageId) {
      this.continueGameMessageIds.set(gameKey, messageId);

      // Thiết lập timeout 15 giây
      const timeout = setTimeout(async () => {
        await this.handleContinueGameTimeout(gameKey, game);
      }, 15000);

      this.continueGameTimeouts.set(gameKey, timeout);

      // Thông báo riêng cho người chơi không đủ số dư để tham gia tiếp
      try {
        for (const p of game.players) {
          if (!p?.id) continue;
          const u = await this.userRepository.findOne({
            where: { user_id: p.id },
          });
          const amount = u?.amount || 0;
          if (amount < game.betAmount) {
            await this.sendPrivateMessage(
              p.id,
              `⚠️ Bạn không đủ số dư để tham gia tiếp ván.\nCần: ${game.betAmount.toLocaleString('vi-VN')} • Hiện có: ${amount.toLocaleString('vi-VN')}`,
              game.clanId,
              game.channelId,
            );
          }
        }
      } catch (e) {
        // ignore notify errors
      }
    } else {
      console.error('❌ Failed to send continue game message');
    }
  }

  // Xử lý timeout cho continue game invitation
  private async handleContinueGameTimeout(
    gameKey: string,
    game: Game,
  ): Promise<void> {
    try {
      // Kiểm tra xem có người chơi nào đã chấp nhận không
      const acceptedPlayers = this.continueGamePlayers.get(gameKey);
      const gameInfo = this.continueGameInfo.get(gameKey);

      if (acceptedPlayers && gameInfo && acceptedPlayers.size >= 2) {
        // Gom danh sách người chơi đã chấp nhận: lấy từ acceptedPlayers (ưu tiên từ DB nếu có)
        const acceptedIds = Array.from(acceptedPlayers);

        // Resolve tên cho từng id (ưu tiên gameInfo, DB, Mezon)
        let acceptedPlayerObjects = [] as {
          id: string;
          name: string;
          seat: number;
        }[];
        for (let i = 0; i < acceptedIds.length; i++) {
          const id = acceptedIds[i] as string;
          const name = await this.resolvePlayerName(game.clanId, id, gameInfo);
          acceptedPlayerObjects.push({ id, name, seat: i });
        }

        // Giới hạn tối đa 8 người
        if (acceptedPlayerObjects.length > 8) {
          acceptedPlayerObjects = acceptedPlayerObjects.slice(0, 8);
        }

        await this.startNewGameFromContinue(
          game.clanId,
          game.channelId,
          game.id,
          acceptedPlayerObjects,
          gameInfo,
        );

        // Xóa message invitation
        const messageId = this.continueGameMessageIds.get(gameKey);
        if (messageId) {
          await this.deleteChannelMessage(
            game.clanId,
            game.channelId,
            messageId,
          );
        }

        // Xóa tất cả thông tin continue game
        this.cleanupContinueGameData(gameKey);
      } else {
        // Không đủ người chơi, kết thúc
        const messageId = this.continueGameMessageIds.get(gameKey);
        if (messageId) {
          await this.deleteChannelMessage(
            game.clanId,
            game.channelId,
            messageId,
          );
        }

        // Hoàn tiền cho những người đã bị trừ nếu không đủ người
        try {
          const paidSet = this.continueGamePaid.get(gameKey);
          if (paidSet && gameInfo) {
            for (const userId of paidSet) {
              await this.addMoneyToUser(userId, gameInfo.betAmount);
            }
          }
        } catch (e) {}

        // Xóa tất cả thông tin continue game
        this.cleanupContinueGameData(gameKey);

        // Hiển thị thông báo timeout
        await this.sendChannelMessage(
          game.clanId,
          game.channelId,
          '⏰ **Hết thời gian!** Không đủ người chơi để tạo game mới.',
        );
      }
    } catch (error) {
      console.error('Error handling continue game timeout:', error);
    }
  }

  // Xử lý khi người chơi chọn tiếp tục chơi
  async continueGame(
    clanId: string,
    channelId: string,
    gameId: string,
    playerId: string,
  ): Promise<void> {
    try {
      const gameKey = this.createGameKey(clanId, channelId, gameId);

      // Kiểm tra xem invitation còn hiệu lực không
      if (!this.continueGamePlayers.has(gameKey)) {
        await this.sendChannelMessage(
          clanId,
          channelId,
          '❌ Lời mời chơi lại đã hết hạn.',
        );
        return;
      }

      // Lấy thông tin game đã lưu
      const gameInfo = this.continueGameInfo.get(gameKey);
      if (!gameInfo) {
        await this.sendChannelMessage(
          clanId,
          channelId,
          '❌ Không tìm thấy thông tin game để tiếp tục.',
        );
        return;
      }

      // Thêm người chơi vào danh sách accept (cho phép bất kỳ user trong channel)
      const acceptedPlayers = this.continueGamePlayers.get(gameKey);

      // Kiểm tra số dư trước khi cho phép tham gia
      const userForJoin = await this.userRepository.findOne({
        where: { user_id: playerId },
      });
      const currentAmount = userForJoin?.amount || 0;
      if (currentAmount < gameInfo.betAmount) {
        await this.sendPrivateMessage(
          playerId,
          `⚠️ Bạn không đủ số dư để tham gia ván tiếp theo.\nCần: ${gameInfo.betAmount.toLocaleString('vi-VN')} • Hiện có: ${currentAmount.toLocaleString('vi-VN')}`,
          clanId,
          channelId,
        );
        return;
      }

      acceptedPlayers?.add(playerId);

      // Trừ tiền ngay khi người dùng bấm tham gia nếu chưa trừ
      try {
        const paidSet = this.continueGamePaid.get(gameKey);
        if (paidSet && !paidSet.has(playerId)) {
          const deductResult = await this.deductPlayersFunds(
            [playerId],
            gameInfo.betAmount,
          );
          if (deductResult.success) {
            paidSet.add(playerId);
          } else {
            // Nếu trừ tiền thất bại, hủy tham gia
            acceptedPlayers?.delete(playerId);
            await this.sendPrivateMessage(
              playerId,
              `❌ Không thể trừ tiền tham gia ván mới: ${deductResult.message}`,
              clanId,
              channelId,
            );
            return;
          }
        }
      } catch (e) {
        // Nếu lỗi khi trừ tiền, hủy tham gia
        acceptedPlayers?.delete(playerId);
        await this.sendPrivateMessage(
          playerId,
          '❌ Có lỗi khi trừ tiền tham gia ván mới.',
          clanId,
          channelId,
        );
        return;
      }

      const acceptedCount = acceptedPlayers?.size || 0;

      // Lấy tên hiển thị ưu tiên từ gameInfo, DB hoặc Mezon
      const playerName = await this.resolvePlayerName(
        clanId,
        playerId,
        gameInfo,
      );

      // Thông báo số người đã đăng ký
      await this.sendPrivateMessage(
        playerId,
        `✅ **${playerName}** đã đăng ký chơi ván mới! (hiện có ${acceptedCount} người)`,
        clanId,
        channelId,
      );

      // Không autostart ngay; đợi timeout để gom nhóm, giữ nguyên hành vi
    } catch (error) {
      console.error('Error continuing game:', error);
      await this.sendChannelMessage(
        clanId,
        channelId,
        `❌ Lỗi khi xử lý yêu cầu: ${error.message}`,
      );
    }
  }

  // Xử lý khi người chơi từ chối tiếp tục
  async declineGame(
    clanId: string,
    channelId: string,
    gameId: string,
    playerId: string,
  ): Promise<void> {
    try {
      const gameKey = this.createGameKey(clanId, channelId, gameId);

      // Kiểm tra xem invitation còn hiệu lực không
      if (!this.continueGamePlayers.has(gameKey)) {
        await this.sendChannelMessage(
          clanId,
          channelId,
          '❌ Lời mời chơi lại đã hết hạn.',
        );
        return;
      }

      // Lấy thông tin game và tên người chơi (không hiển thị id)
      const gameInfo = this.continueGameInfo.get(gameKey);
      const playerName = await this.resolvePlayerName(
        clanId,
        playerId,
        gameInfo,
      );

      // Xóa người chơi khỏi danh sách accept (nếu có)
      const acceptedPlayers = this.continueGamePlayers.get(gameKey);
      acceptedPlayers?.delete(playerId);

      await this.sendChannelMessage(
        clanId,
        channelId,
        `👋 **${playerName}** đã từ chối.`,
      );
    } catch (error) {
      console.error('Error declining game:', error);
    }
  }

  // Bắt đầu game mới từ continue game
  private async startNewGameFromContinue(
    clanId: string,
    channelId: string,
    gameId: string,
    players: any[],
    gameInfo: any,
  ): Promise<void> {
    try {
      const gameKey = this.createGameKey(clanId, channelId, gameId);

      // Xóa message invitation
      const messageId = this.continueGameMessageIds.get(gameKey);
      if (messageId) {
        await this.deleteChannelMessage(clanId, channelId, messageId);
      }

      // Xóa tất cả thông tin continue game
      this.cleanupContinueGameData(gameKey);

      // Validate số lượng người chơi và chuẩn hóa danh sách (id, name)
      const uniqueById = new Map<string, any>();
      for (const p of players) {
        if (p?.id) {
          uniqueById.set(p.id, p);
        }
      }

      const normalizedPlayers = Array.from(uniqueById.values()).slice(0, 8);

      if (normalizedPlayers.length < 2) {
        await this.sendChannelMessage(
          clanId,
          channelId,
          '❌ Không đủ người chơi để bắt đầu ván mới (cần ít nhất 2).',
        );
        return;
      }

      // Tạo game mới (KHÔNG trừ tiền lại nếu đã trừ khi bấm tham gia)
      const newGameId = `poker_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      await this.createNewGame(
        clanId,
        channelId,
        newGameId,
        gameInfo.betAmount || 1000,
        normalizedPlayers,
      );

      // const createdMsgId = await this.sendChannelMessage(
      //   clanId,
      //   channelId,
      //   `🎰 **Game mới đã được tạo!** Game ID: ${newGameId}\n` +
      //     `🎮 Người chơi: ${normalizedPlayers
      //       .map((p: any) => p.name)
      //       .join(', ')}\n` +
      //     `💸 Mức cược: ${(gameInfo.betAmount || 1000).toLocaleString()} token`,
      // );
      // if (createdMsgId) {
      //   const newGameKey = this.createGameKey(clanId, channelId, newGameId);
      //   this.newGameCreatedMessageIds.set(newGameKey, createdMsgId);
      // }
    } catch (error) {
      console.error('Error starting new game from continue:', error);
      await this.sendChannelMessage(
        clanId,
        channelId,
        `❌ Lỗi khi tạo game mới: ${error.message}`,
      );
    }
  }

  // Tạo game mới với danh sách người chơi
  private async createNewGame(
    clanId: string,
    channelId: string,
    gameId: string,
    betAmount: number,
    players: any[],
  ): Promise<void> {
    try {
      // Tạo game mới
      const newGame: Game = {
        id: gameId,
        clanId,
        channelId,
        createdAt: new Date(),
        players: players.map((p: any, index: number) => ({
          id: p.id,
          name: p.name,
          chips: betAmount, // Mỗi người góp trước betAmount, đồng bộ với pot ban đầu
          seat: index,
          hole: [],
          hasFolded: false,
          currentBet: 0,
          isAllIn: false,
        })),
        deck: this.createDeck(),
        burned: [],
        board: [],
        pot: players.length * betAmount, // Pot khởi tạo = tổng tiền cược của tất cả người chơi
        currentBet: 0,
        round: 'waiting',
        dealerButton: 0,
        currentPlayerIndex: 0,
        isActive: true,
        hasRaiseInRound: false,
        betAmount,
        lastAggressorIndex: null,
        toActIds: [],
        actionHistory: [],
      };

      // Shuffle deck
      this.shuffleDeck(newGame.deck);

      // Lưu game vào database
      const pokerGame = new PokerGame();
      pokerGame.clanId = clanId;
      pokerGame.channelId = channelId;
      pokerGame.creatorId = players[0].id;
      pokerGame.isActive = true;
      pokerGame.gameState = newGame as any;

      await this.pokerGameRepository.save(pokerGame);

      // Thêm game vào activeGames
      const gameKey = this.createGameKey(clanId, channelId, gameId);
      this.activeGames.set(gameKey, newGame);

      // Bắt đầu game mới
      await this.dealCardsAndStartGame(gameKey);
    } catch (error) {
      console.error('Error creating new game:', error);
      throw error;
    }
  }

  // Helper method để tạo gameKey với gameId
  private createGameKey(
    clanId: string,
    channelId: string,
    gameId: string,
  ): string {
    return `${clanId}_${channelId}_${gameId}`;
  }

  // Helper method để tạo gameKey cho invite (chưa có gameId)
  private createInviteKey(clanId: string, channelId: string): string {
    return `${clanId}_${channelId}`;
  }

  private addActionToHistory(
    game: Game,
    playerId: string,
    action: 'bet' | 'call' | 'raise' | 'check' | 'fold' | 'allin',
    amount?: number,
    totalBet?: number,
  ): void {
    const player = game.players.find((p) => p.id === playerId);
    if (player) {
      const playerAction: PlayerAction = {
        playerId,
        playerName: player.name,
        action,
        amount,
        totalBet,
        timestamp: new Date(),
        round: game.round,
      };
      game.actionHistory.push(playerAction);
    }
  }

  // Helper method để format action history
  private formatActionHistory(game: Game): string {
    if (game.actionHistory.length === 0) {
      return '';
    }

    // Lấy 5 action gần nhất
    const recentActions = game.actionHistory.slice(-5);

    const actionTexts = recentActions.map((action) => {
      const actionEmoji = {
        bet: '💸',
        call: '📞',
        raise: '💸',
        check: '✅',
        fold: '📄',
        allin: '🔥',
      }[action.action];

      let actionText = `${actionEmoji} **${action.playerName}** ${action.action.toUpperCase()}`;

      if (
        action.amount &&
        action.action !== 'check' &&
        action.action !== 'fold'
      ) {
        actionText += ` ${action.amount.toLocaleString()} 💸`;
      }

      if (
        action.totalBet &&
        (action.action === 'bet' ||
          action.action === 'raise' ||
          action.action === 'allin')
      ) {
        actionText += ` (Total: ${action.totalBet.toLocaleString()})`;
      }

      return actionText;
    });

    return `\n📋 **Action History:**\n${actionTexts.join('\n')}\n`;
  }

  constructor(
    @InjectRepository(PokerGame)
    private pokerGameRepository: Repository<PokerGame>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private mezonClientService: MezonClientService,
  ) {
    this.client = this.mezonClientService.getClient();
  }

  // Resolve a player's display name from cached game info, DB, or Mezon
  private async resolvePlayerName(
    clanId: string,
    playerId: string,
    gameInfo?: any,
  ): Promise<string> {
    try {
      if (gameInfo?.players) {
        const found = (gameInfo.players as any[]).find(
          (p) => p.id === playerId,
        );
        if (found?.name) return found.name;
      }

      const dbUser = await this.userRepository.findOne({
        where: { user_id: playerId },
      });
      if (dbUser?.username) return dbUser.username;

      const client = this.mezonClientService.getClient();
      const mezonUser = await client.users.fetch(playerId as any);
      const displayName =
        (mezonUser as any)?.display_name || (mezonUser as any)?.username;
      if (displayName) return displayName;
    } catch (_) {}

    return playerId;
  }

  public getGameInvite(gameId: string): PokerInvite | null {
    for (const [key, invite] of this.gameInvites.entries()) {
      if (invite.gameId === gameId) {
        return invite;
      }
    }

    return null;
  }

  // Check if players have enough funds
  public async checkPlayersFunds(
    playerIds: any[],
    betAmount: number,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const insufficientFundsPlayers: string[] = [];

      for (const playerId of playerIds) {
        const user = await this.userRepository.findOne({
          where: { user_id: playerId.idUser },
        });

        if (!user) {
          return {
            success: false,
            message: `Người chơi ${playerId.name} không tồn tại trong hệ thống`,
          };
        }

        if (user.amount < betAmount) {
          insufficientFundsPlayers.push(
            user.display_name || user.username || playerId,
          );
        }
      }

      if (insufficientFundsPlayers.length > 0) {
        return {
          success: false,
          message: `Người chơi sau không đủ tiền: ${insufficientFundsPlayers.join(', ')} (Cần: ${betAmount.toLocaleString()})`,
        };
      }

      return { success: true };
    } catch (error) {
      console.error('Error checking player funds:', error);
      return {
        success: false,
        message: 'Lỗi kiểm tra số dư người chơi',
      };
    }
  }

  public async deductPlayersFunds(
    playerIds: string[],
    betAmount: number,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      for (const playerId of playerIds) {
        const user = await this.userRepository.findOne({
          where: { user_id: playerId },
        });

        if (user && user.amount >= betAmount) {
          const oldAmount = user.amount;
          user.amount -= betAmount;
          await this.userRepository.save(user);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error deducting player funds:', error);
      return {
        success: false,
        message: 'Lỗi trừ tiền người chơi',
      };
    }
  }

  public async setInviteMessageId(
    gameId: string,
    messageId: string,
    clanId: string,
    channelId: string,
  ): Promise<void> {
    const invite = this.getGameInvite(gameId);
    if (invite) {
      invite.messageId = messageId;
    }
  }

  // Utility: build responses summary for UI
  public getInviteResponses(gameId: string): InviteResponsesSummary {
    const invite = this.getGameInvite(gameId);
    if (!invite) return { joined: [], declined: [], pending: [] };

    const joined = invite.confirmedUsers.slice();
    const declined = invite.declinedUsers.slice();
    const pending = invite.mentionedUsers.filter(
      (u) => !joined.includes(u.idUser) && !declined.includes(u.idUser),
    );
    return { joined, declined, pending };
  }

  public async sendEphemeralMessage(
    userId: string,
    content: string,
    channel_id: string,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channel_id);
    await channel.sendEphemeral(userId, {
      t: content,

      mk: [
        {
          type: EMarkdownType.PRE,
          s: 0,
          e: content.length,
        },
      ],
    });
  }

  public async updateMessage(
    messageId: string,
    content: string,
    channelId: string,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.update({
      t: content,
      mk: [{ type: EMarkdownType.PRE, s: 0, e: content.length }],
    });
  }

  // Update invite message với trạng thái mới

  public async handleButtonClick(
    userId: string,
    action: 'poker_join' | 'poker_decline',
    gameId: string,
    channelId: string,
    messageId: string,
    clanId: string,
  ): Promise<ButtonActionResult> {
    const invite = this.getGameInvite(gameId);
    if (!invite) {
      return {
        success: false,
        message: 'Invite không tồn tại hoặc đã hết hạn',
      };
    }

    if (userId === invite.creatorId) {
      return {
        success: false,
        message: 'Bạn đã tự động tham gia game rồi!',
      };
    }

    const inviteKey = this.createInviteKey(invite.clanId, invite.channelId);
    const playerTimeoutKey = `${inviteKey}_${userId}`;
    const playerTimeout = this.playerTimeouts.get(playerTimeoutKey);
    if (playerTimeout) {
      clearTimeout(playerTimeout);
      this.playerTimeouts.delete(playerTimeoutKey);
    }

    if (action === 'poker_join') {
      if (!invite.confirmedUsers.includes(userId)) {
        invite.confirmedUsers.push(userId);
        await this.sendEphemeralMessage(userId, 'Đã tham gia game', channelId);
      }
      invite.declinedUsers = invite.declinedUsers.filter((u) => u !== userId);
    } else if (action === 'poker_decline') {
      if (!invite.declinedUsers.includes(userId)) {
        invite.declinedUsers.push(userId);
        await this.sendEphemeralMessage(
          userId,
          'Đã từ chối tham gia',
          channelId,
        );
      }
      invite.confirmedUsers = invite.confirmedUsers.filter((u) => u !== userId);
    }
    const pendingPlayers = invite.mentionedUsers.filter(
      (id) =>
        !invite.confirmedUsers.includes(id.idUser) &&
        !invite.declinedUsers.includes(id.idUser),
    );

    const totalResponses =
      invite.confirmedUsers.length + invite.declinedUsers.length;
    const totalInvited = invite.mentionedUsers.length;

    if (totalResponses === totalInvited) {
      // Tìm inviteKey thực tế từ gameInvites map
      let actualInviteKey = '';
      for (const [key, storedInvite] of this.gameInvites.entries()) {
        if (storedInvite.gameId === invite.gameId) {
          actualInviteKey = key;
          break;
        }
      }

      if (actualInviteKey) {
        const timeout = this.inviteTimeouts.get(actualInviteKey);
        if (timeout) {
          clearTimeout(timeout);
          this.inviteTimeouts.delete(actualInviteKey);
        }
        await this.startGameFromInvite(actualInviteKey, messageId);
      }

      return {
        success: true,
        message:
          action === 'poker_join' ? 'Đã tham gia game' : 'Đã từ chối tham gia',
        shouldUpdate: true,
        gameStarted: true,
      };
    }

    return {
      success: true,
      message:
        action === 'poker_join' ? 'Đã tham gia game' : 'Đã từ chối tham gia',
      shouldUpdate: true,
      gameStarted: false,
    };
  }

  async createInvite(
    creatorId: string,
    clanId: string,
    channelId: string,
    messageId: string,
    allPlayers: { idUser: string; name: string }[],
    betAmount: number = 1000,
  ): Promise<InviteResult> {
    const gameId = `poker_${Date.now()}`;
    const inviteKey = `${clanId}_${channelId}_${gameId}`;

    // Không cần kiểm tra invite nữa vì giờ có thể có nhiều game trong cùng 1 channel

    const realPlayers = allPlayers;

    const invite: PokerInvite = {
      gameId,
      creatorId,
      clanId,
      channelId,
      messageId,
      mentionedUsers: realPlayers, // Chỉ những người chọi thật
      confirmedUsers: [creatorId], // Người tạo lệnh tự động tham gia
      declinedUsers: [],
      expiresAt: new Date(Date.now() + this.INVITE_TIMEOUT),
      betAmount,
    };

    this.gameInvites.set(inviteKey, invite);

    // Tạo timeout cho từng người chơi (trừ người tạo lệnh vì họ đã tự động tham gia)
    for (const playerId of realPlayers) {
      if (playerId.idUser !== creatorId) {
        const playerTimeoutKey = `${inviteKey}_${playerId.idUser}`;
        const timeout = setTimeout(async () => {
          await this.handlePlayerTimeout(inviteKey, playerId.idUser);
        }, this.INVITE_TIMEOUT);

        this.playerTimeouts.set(playerTimeoutKey, timeout);
      }
    }

    // Set timeout chung để start game sau khi tất cả timeout (chỉ khi chưa đủ người)
    const gameTimeout = setTimeout(async () => {
      if (this.gameInvites.has(inviteKey)) {
        await this.startGameFromInvite(inviteKey);
      }
    }, this.INVITE_TIMEOUT);

    this.inviteTimeouts.set(inviteKey, gameTimeout);

    return {
      success: true,
      gameId,
      message: 'Invite đã được tạo',
    };
  }

  // Xử lý khi người chơi hết thời gian phản hồi
  private async handlePlayerTimeout(
    inviteKey: string,
    playerId: string,
  ): Promise<void> {
    const invite = this.gameInvites.get(inviteKey);
    if (!invite) return;

    // Xóa player khỏi danh sách pending nếu chưa confirm
    if (
      !invite.confirmedUsers.includes(playerId) &&
      !invite.declinedUsers.includes(playerId)
    ) {
      // Thêm vào declined users
      invite.declinedUsers.push(playerId);

      // Gửi thông báo cho người chơi
      try {
        await this.sendEphemeralMessage(
          playerId,
          '⏰ Hết thời gian phản hồi! Bạn đã bị loại khỏi game.',
          invite.channelId,
        );
      } catch (error) {
        console.error('Error sending timeout message:', error);
      }
    }

    const playerTimeoutKey = `${inviteKey}_${playerId}`;
    const timeout = this.playerTimeouts.get(playerTimeoutKey);
    if (timeout) {
      clearTimeout(timeout);
      this.playerTimeouts.delete(playerTimeoutKey);
    }
  }

  private async startGameFromInvite(
    inviteKey: string,
    messageId?: string | undefined,
  ): Promise<GameResult> {
    const invite = this.gameInvites.get(inviteKey);
    if (!invite) {
      return {
        success: false,
        message: 'Invite không tồn tại',
      };
    }

    // Delete invite immediately to prevent duplicate processing
    this.gameInvites.delete(inviteKey);

    const timeout = this.inviteTimeouts.get(inviteKey);
    if (timeout) {
      clearTimeout(timeout);
      this.inviteTimeouts.delete(inviteKey);
    }

    const updateInterval = this.inviteUpdateIntervals.get(inviteKey);
    if (updateInterval) {
      clearInterval(updateInterval);
      this.inviteUpdateIntervals.delete(inviteKey);
    }

    // Nếu không có ai confirm, hủy game
    if (invite.confirmedUsers.length === 0) {
      try {
        if (invite.messageId) {
          await this.editChannelMessage(
            invite.clanId,
            invite.channelId,
            invite.messageId,
            `❌ **Game đã bị hủy**\nKhông có ai tham gia game.`,
            [], // Không có components nữa
          );
        } else {
          await this.sendChannelMessage(
            invite.clanId,
            invite.channelId,
            `❌ Không có ai tham gia game. Game đã bị hủy.`,
          );
        }
      } catch (error) {
        console.error('Lỗi gửi thông báo:', error);
      }
      return {
        success: false,
        message: 'Không đủ người chơi để bắt đầu game',
      };
    }

    // Logic xử lý players
    let finalPlayers = invite.confirmedUsers;

    if (invite.confirmedUsers.length < 2) {
      // Nếu ít hơn 2 người: hủy game
      try {
        if (invite.messageId) {
          await this.editChannelMessage(
            invite.clanId,
            invite.channelId,
            invite.messageId,
            `❌ **Game đã bị hủy**\nKhông đủ người chơi để bắt đầu game (tối thiểu 2 người).\nHiện tại: ${invite.confirmedUsers.length} người`,
            [], // Không có components nữa
          );
        } else {
          await this.sendChannelMessage(
            invite.clanId,
            invite.channelId,
            `❌ Không đủ người chơi để bắt đầu game (tối thiểu 2 người). Hiện tại: ${invite.confirmedUsers.length} người`,
          );
        }
      } catch (error) {
        console.error('Lỗi gửi thông báo:', error);
      }
      return {
        success: false,
        message: 'Không đủ người chơi để bắt đầu game',
      };
    }

    try {
      const game = await this.startGame(
        invite.creatorId,
        invite.clanId,
        invite.channelId,
        finalPlayers,
        invite.betAmount,
      );

      // Update message invite ban đầu thay vì gửi message mới
      if (invite.messageId) {
        await this.editChannelMessage(
          invite.clanId,
          invite.channelId,
          invite.messageId,
          `🎮 **Game đã bắt đầu!**`,
          [], // Không có components nữa
        );
      } else {
        // Fallback nếu không có messageId
        await this.sendChannelMessage(
          invite.clanId,
          invite.channelId,
          `🎮 Game #${game.id} đã bắt đầu với ${finalPlayers.length} người chơi!`,
        );
      }
    } catch (error) {
      console.error('Lỗi tạo game từ invite:', error);
      return {
        success: false,
        message: 'Lỗi tạo game từ invite',
      };
    }

    return {
      success: true,
      message: 'Game đã bắt đầu thành công',
      gameStarted: true,
    };
  }

  async startGame(
    creatorId: string,
    clanId: string,
    channelId: string,
    playerIds: string[],
    betAmount: number = 1000,
  ): Promise<Game> {
    const gameId = `poker_${Date.now()}`;
    const gameKey = this.createGameKey(clanId, channelId, gameId);

    const deck = this.createDeck();
    this.shuffleDeck(deck);

    // Tạo danh sách người chơi với tên hiển thị từ Mezon nếu có
    const players: Player[] = [];

    for (let index = 0; index < playerIds.length; index++) {
      const id = playerIds[index];
      let displayName = `Player${index + 1}`;

      try {
        {
          try {
            const dbUser = await this.userRepository.findOne({
              where: { user_id: id },
            });
            if (dbUser && (dbUser.display_name || dbUser.username)) {
              displayName = (dbUser.display_name || dbUser.username) as string;
            } else {
              // Fallback to Mezon API
              const client = this.mezonClientService.getClient();
              if (client.users?.fetch) {
                const user = await client.users.fetch(id);

                if (user) {
                  displayName = (user.display_name ||
                    user.username ||
                    displayName) as string;
                }
              }
            }
          } catch (dbError) {
            // Fallback to Mezon API
            const client = this.mezonClientService.getClient();
            if (client.users?.fetch) {
              const user = await client.users.fetch(id);
              if (user) {
                displayName = (user.display_name ||
                  user.username ||
                  displayName) as string;
              }
            }
          }
        }
      } catch (e) {
        // fallback giữ nguyên displayName mặc định
      }

      const player = {
        id,
        name: displayName,
        chips: 0, // Plan A: chips = 0; tiền buy-in đi thẳng vào pot
        seat: index,
        hole: [],
        hasFolded: false,
        currentBet: 0,
        isAllIn: false,
      };

      players.push(player);
    }

    const game: Game = {
      id: gameId,
      clanId,
      channelId,
      createdAt: new Date(),
      players,
      deck,
      burned: [],
      board: [],
      pot: playerIds.length * betAmount, // Plan A: pot khởi tạo = tổng buy-in
      currentBet: 0,
      round: 'waiting', // Chờ phát bài
      dealerButton: 0,
      currentPlayerIndex: 0,
      isActive: true,
      hasRaiseInRound: false,
      betAmount, // Store the bet amount used for this game
      lastAggressorIndex: null,
      toActIds: [],
      actionHistory: [],
    };

    try {
      // Deduct money from all players
      const deductResult = await this.deductPlayersFunds(playerIds, betAmount);

      if (!deductResult.success) {
        throw new Error(
          deductResult.message || 'Failed to deduct player funds',
        );
      }

      this.activeGames.set(gameKey, game);

      await this.saveGameToDatabase(game);

      // Tạo timeout để phát bài sau 30 giây
      const timeout = setTimeout(async () => {
        await this.dealCardsAndStartGame(gameKey);
      }, this.DEAL_DELAY);

      this.gameTimeouts.set(gameKey, timeout);

      return game;
    } catch (error) {
      console.error('❌ Error in startGame:', error);
      // Xóa game khỏi Map nếu có lỗi
      this.activeGames.delete(gameKey);
      throw error;
    }
  }

  async getActiveGame(
    clanId: string,
    channelId: string,
    gameId: string,
  ): Promise<Game | null> {
    const gameKey = this.createGameKey(clanId, channelId, gameId);

    const game = this.activeGames.get(gameKey);

    if (!game || !game.isActive) {
      return null;
    }

    return game;
  }

  async makeRaise(
    clanId: string,
    channelId: string,
    gameId: string,
    playerId: string,
    toTotal: number,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    const amountToAdd = toTotal - currentPlayer.currentBet;
    if (amountToAdd <= 0 || amountToAdd > currentPlayer.chips) {
      return { success: false, message: 'Số tiền raise không hợp lệ' };
    }

    if (toTotal <= game.currentBet) {
      return { success: false, message: 'Raise phải lớn hơn current bet' };
    }

    // Kiểm tra tiền từ database
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;

    if (userAmount < amountToAdd) {
      const buttons: any[] = [];

      buttons.push({
        id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Call (${(game.currentBet - currentPlayer.currentBet).toLocaleString('vi-VN')})`,
          style: EButtonMessageStyle.PRIMARY as any,
        },
      });

      buttons.push({
        id: `poker_raise_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Raise (+${amountToAdd.toLocaleString('vi-VN')})`,
          style: EButtonMessageStyle.SUCCESS as any,
        },
      });

      buttons.push({
        id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '📄 Fold',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      const components = [
        {
          components: buttons,
        },
      ];
      const sendMessage = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `❌ **${currentPlayer.name} Không đủ tiền để raise!**\n💸 Số tiền cần: ${amountToAdd.toLocaleString()} token \n💸 Số tiền bạn có: ${userAmount.toLocaleString()} token\n💸 Thiếu: ${(amountToAdd - userAmount).toLocaleString()} token\n🎯 **Lựa chọn của bạn:**`,
        components,
      );

      // Lưu message ID để có thể xóa sau này
      if (sendMessage) {
        const gameKey = this.createGameKey(
          game.clanId,
          game.channelId,
          game.id,
        );
        const messageKey = `insufficient_${gameKey}_${playerId}`;
        this.insufficientFundsMessageIds.set(messageKey, sendMessage);
      }

      // Set timeout cho insufficient funds (30 giây)
      const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
      const timeoutKey = `insufficient_${gameKey}_${playerId}`;
      const timeout = setTimeout(() => {
        this.handleInsufficientFundsTimeout(game, playerId);
      }, 30000);
      this.insufficientFundsTimeouts.set(timeoutKey, timeout);

      return {
        success: false,
        message: `Không đủ tiền để raise! Cần: ${amountToAdd.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Trừ tiền từ database
    if (user) {
      user.amount -= amountToAdd;
      await this.userRepository.save(user);
    }

    // Thực hiện raise (Plan A: trừ trực tiếp DB, không đụng chips)
    currentPlayer.currentBet = toTotal;
    game.pot += amountToAdd;
    game.currentBet = toTotal;
    game.hasRaiseInRound = true; // Mark that someone has raised in this round

    // Nếu raise hết tiền thì đánh dấu all-in
    if (currentPlayer.chips === 0) {
      currentPlayer.isAllIn = true;
    }

    // --- NEW: ghi nhận aggressor & bắt mọi người khác phải hành động lại
    game.lastAggressorIndex = game.currentPlayerIndex;
    this.setToActAfterRaise(game, playerId);

    await this.saveGameToDatabase(game);

    // Xóa turn message khi người chơi đã hành động
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Xóa insufficient funds timeout vì đã raise thành công
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }

    // Xóa insufficient funds message nếu có
    await this.clearInsufficientFundsMessage(game, playerId);

    // Thêm action vào history
    this.addActionToHistory(game, playerId, 'raise', amountToAdd, toTotal);

    await this.moveToNextPlayer(game);

    return { success: true, message: `Raise to ${toTotal}`, game };
  }

  async makeCall(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }
    if (messageId) {
      await this.deleteChannelMessage(clanId, channelId, messageId);
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    const amountToCall = game.currentBet - currentPlayer.currentBet;
    if (amountToCall <= 0) {
      return { success: false, message: 'Không có gì để call' };
    }

    // Kiểm tra tiền từ database
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;

    if (userAmount < amountToCall) {
      const buttons: any[] = [];

      buttons.push({
        id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Call (${amountToCall.toLocaleString('vi-VN')})`,
          style: EButtonMessageStyle.PRIMARY as any,
        },
      });

      // buttons.push({
      //   id: `poker_allin_${game.id}_${game.clanId}_${game.channelId}`,
      //   type: EMessageComponentType.BUTTON as any,
      //   component: {
      //     label: `🔥 All-in (${userAmount.toLocaleString('vi-VN')})`,
      //     style: EButtonMessageStyle.DANGER as any,
      //   },
      // });

      buttons.push({
        id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '📄 Fold',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      const components = [
        {
          components: buttons,
        },
      ];
      const sendMessage = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `❌ **${currentPlayer.name} Không đủ tiền để call!**\n💸 Số tiền cần: ${amountToCall.toLocaleString()} token \n💸 Số tiền bạn có: ${userAmount.toLocaleString()} token\n💸 Thiếu: ${(amountToCall - userAmount).toLocaleString()} token\n🎯 **Lựa chọn của bạn:**`,
        components,
      );

      // Lưu message ID để có thể xóa sau này
      if (sendMessage) {
        const gameKey = this.createGameKey(
          game.clanId,
          game.channelId,
          game.id,
        );
        const messageKey = `insufficient_${gameKey}_${playerId}`;
        this.insufficientFundsMessageIds.set(messageKey, sendMessage);
      }

      // Set timeout cho insufficient funds (30 giây)
      const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
      const timeoutKey = `insufficient_${gameKey}_${playerId}`;
      const timeout = setTimeout(() => {
        this.handleInsufficientFundsTimeout(game, playerId);
      }, 30000);
      this.insufficientFundsTimeouts.set(timeoutKey, timeout);

      return {
        success: false,
        message: `Không đủ tiền để call! Cần: ${amountToCall.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Trừ tiền từ database
    if (user) {
      user.amount -= amountToCall;
      await this.userRepository.save(user);
    }

    // Thực hiện call (Plan A: trừ trực tiếp DB, không đụng chips)
    currentPlayer.currentBet += amountToCall;
    game.pot += amountToCall;

    await this.saveGameToDatabase(game);

    this.removeFromToAct(game, playerId);

    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }

    // Xóa insufficient funds message nếu có
    await this.clearInsufficientFundsMessage(game, playerId);

    // Thêm action vào history
    this.addActionToHistory(
      game,
      playerId,
      'call',
      amountToCall,
      currentPlayer.currentBet,
    );

    // await this.sendChannelMessage(
    //   game.clanId,
    //   game.channelId,
    //   `💸 **${currentPlayer.name}** CALL ${amountToCall.toLocaleString()} 💸\n\n🎯 Pot: ${game.pot.toLocaleString()} 💸 | Mức cược: ${game.currentBet.toLocaleString()} 💸`,
    // );

    await this.moveToNextPlayer(game);

    return {
      success: true,
      message: `Call ${amountToCall.toLocaleString()} 💸`,
      game,
    };
  }

  async makeCheck(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);

    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    await this.deleteChannelMessage(clanId, channelId, messageId);

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    if (currentPlayer.currentBet < game.currentBet) {
      return {
        success: false,
        message: `Không thể check, phải call hoặc fold (Bạn: ${currentPlayer.currentBet}, Cần: ${game.currentBet})`,
      };
    }

    await this.saveGameToDatabase(game);

    this.removeFromToAct(game, playerId);

    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Thêm action vào history
    this.addActionToHistory(game, playerId, 'check');

    await this.moveToNextPlayer(game);

    return { success: true, message: 'Check', game };
  }

  async makeFold(
    clanId: string,
    channelId: string,
    gameId: string,
    playerId: string,
    messageId?: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    if (messageId) {
      await this.deleteChannelMessage(clanId, channelId, messageId);
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold rồi' };
    }

    // Thực hiện fold
    currentPlayer.hasFolded = true;

    await this.saveGameToDatabase(game);

    // --- NEW ---
    this.removeFromToAct(game, playerId);

    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Xóa insufficient funds timeout vì đã fold
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }

    // Xóa insufficient funds message nếu có
    await this.clearInsufficientFundsMessage(game, playerId);

    // Thêm action vào history
    this.addActionToHistory(game, playerId, 'fold');

    await this.moveToNextPlayer(game);

    return { success: true, message: 'Fold', game };
  }

  async makeRaiseByBetAmount(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    await this.deleteChannelMessage(clanId, channelId, messageId);

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    // Tính toán raise amount = bet amount ban đầu
    const raiseAmount = game.betAmount;
    const newTotalBet = game.currentBet + raiseAmount;
    const amountToAdd = newTotalBet - currentPlayer.currentBet;

    if (amountToAdd <= 0) {
      return {
        success: false,
        message: 'Không thể raise, số tiền không hợp lệ',
      };
    }

    // Kiểm tra tiền từ database
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;

    if (userAmount < amountToAdd) {
      const buttons: any[] = [];

      buttons.push({
        id: `poker_check_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '👁️ Check',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      buttons.push({
        id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Call (${amountToAdd.toLocaleString('vi-VN')})`,
          style: EButtonMessageStyle.PRIMARY as any,
        },
      });

      buttons.push({
        id: `poker_raise_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Raise (+${raiseAmount})`,
          style: EButtonMessageStyle.SUCCESS as any,
        },
      });

      buttons.push({
        id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '📄 Fold',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      const components = [
        {
          components: buttons,
        },
      ];
      // Gửi thông báo riêng cho user về tình trạng tài chính
      await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `❌ **Người chơi ${currentPlayer.name} Không đủ tiền để raise!**\n💸 Số tiền cần: ${amountToAdd.toLocaleString()} 💸\n💸 Số tiền bạn có: ${userAmount.toLocaleString()} 💸\n💸 Thiếu: ${(amountToAdd - userAmount).toLocaleString()} 💸\n\n🎯 **Lựa chọn của bạn:**`,
        components,
      );

      return {
        success: false,
        message: `Không đủ tiền để raise! Cần: ${amountToAdd.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Trừ tiền từ database
    if (user) {
      user.amount -= amountToAdd;
      await this.userRepository.save(user);
    }

    // Plan A: trừ trực tiếp DB, không đụng chips
    currentPlayer.currentBet = newTotalBet;
    game.pot += amountToAdd;
    game.currentBet = newTotalBet;
    game.hasRaiseInRound = true;

    game.lastAggressorIndex = game.currentPlayerIndex;
    this.setToActAfterRaise(game, playerId);
    await this.saveGameToDatabase(game);
    // await this.sendChannelMessage(
    //   game.clanId,
    //   game.channelId,
    //   `💸 **${currentPlayer.name}** RAISE +${amountToAdd.toLocaleString()} 💸 (Total: ${newTotalBet.toLocaleString()} 💸)\n\n🎯 Pot: ${game.pot.toLocaleString()} 💸 | Mức cược: ${game.currentBet.toLocaleString()} 💸`,
    // );

    // Xóa turn message khi người chơi đã hành động
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Xóa insufficient funds timeout vì đã raise thành công
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }

    // Thêm action vào history
    this.addActionToHistory(game, playerId, 'raise', raiseAmount, newTotalBet);

    await this.moveToNextPlayer(game);

    return {
      success: true,
      message: `Raise +${raiseAmount.toLocaleString()} 💸 (Total: ${newTotalBet.toLocaleString()} 💸)`,
      game,
    };
  }

  // Raise theo multiplier (1x, 2x, pot)
  private async makeRaiseGeneric(
    game: Game,
    playerId: string,
    raiseAmount: number,
  ): Promise<{ success: boolean; message: string }> {
    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    const newTotalBet = game.currentBet + raiseAmount;
    const amountToAdd = newTotalBet - currentPlayer.currentBet;
    if (amountToAdd <= 0) {
      return {
        success: false,
        message: 'Không thể raise, số tiền không hợp lệ',
      };
    }

    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;
    if (userAmount < amountToAdd) {
      return { success: false, message: 'Không đủ tiền để raise' };
    }

    if (user) {
      user.amount -= amountToAdd;
      await this.userRepository.save(user);
    }

    // Plan A: trừ trực tiếp DB, không đụng chips
    currentPlayer.currentBet = newTotalBet;
    game.pot += amountToAdd;
    game.currentBet = newTotalBet;
    game.hasRaiseInRound = true;
    game.lastAggressorIndex = game.currentPlayerIndex;
    this.setToActAfterRaise(game, playerId);
    await this.saveGameToDatabase(game);

    return { success: true, message: 'Raised' };
  }

  async makeRaiseByMultiplier(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
    multiplier: number,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    if (messageId) {
      await this.deleteChannelMessage(clanId, channelId, messageId);
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    const raiseAmount = Math.max(0, game.betAmount * multiplier);
    const newTotalBet = game.currentBet + raiseAmount;
    const amountToAdd = newTotalBet - currentPlayer.currentBet;
    if (amountToAdd <= 0) {
      return {
        success: false,
        message: 'Không thể raise, số tiền không hợp lệ',
      };
    }

    // Kiểm tra tiền từ database
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;
    if (userAmount < amountToAdd) {
      return {
        success: false,
        message: `Không đủ tiền để raise! Cần: ${amountToAdd.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Trừ tiền từ database
    if (user) {
      user.amount -= amountToAdd;
      await this.userRepository.save(user);
    }

    // Cập nhật game state (Plan A: không đụng chips)
    currentPlayer.currentBet = newTotalBet;
    game.pot += amountToAdd;
    game.currentBet = newTotalBet;
    game.hasRaiseInRound = true;
    game.lastAggressorIndex = game.currentPlayerIndex;
    this.setToActAfterRaise(game, playerId);
    await this.saveGameToDatabase(game);

    // Xóa turn message khi người chơi đã hành động
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Xóa insufficient funds timeout nếu có
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }
    await this.clearInsufficientFundsMessage(game, playerId);

    // Lịch sử hành động
    this.addActionToHistory(game, playerId, 'raise', raiseAmount, newTotalBet);

    await this.moveToNextPlayer(game);

    return {
      success: true,
      message: `Raise +${raiseAmount.toLocaleString()} 💸 (Total: ${newTotalBet.toLocaleString()} 💸)`,
      game,
    };
  }

  async makeRaiseByPot(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    if (messageId) {
      await this.deleteChannelMessage(clanId, channelId, messageId);
    }

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    // Pot-sized raise: dùng game.pot (tối thiểu betAmount)
    const raiseAmount = Math.max(game.betAmount, game.pot);
    const newTotalBet = game.currentBet + raiseAmount;
    const amountToAdd = newTotalBet - currentPlayer.currentBet;
    if (amountToAdd <= 0) {
      return {
        success: false,
        message: 'Không thể raise, số tiền không hợp lệ',
      };
    }

    // Kiểm tra tiền từ database
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;
    if (userAmount < amountToAdd) {
      return {
        success: false,
        message: `Không đủ tiền để raise! Cần: ${amountToAdd.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Trừ tiền từ database
    if (user) {
      user.amount -= amountToAdd;
      await this.userRepository.save(user);
    }

    // Cập nhật game state (Plan A: không đụng chips)
    currentPlayer.currentBet = newTotalBet;
    game.pot += amountToAdd;
    game.currentBet = newTotalBet;
    game.hasRaiseInRound = true;
    game.lastAggressorIndex = game.currentPlayerIndex;
    this.setToActAfterRaise(game, playerId);
    await this.saveGameToDatabase(game);

    // Xóa turn message khi người chơi đã hành động
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      await this.deleteChannelMessage(
        game.clanId,
        game.channelId,
        turnMessageId,
      );
      this.turnMessageIds.delete(gameKey);
    }

    // Xóa insufficient funds timeout nếu có
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    const insufficientTimeout = this.insufficientFundsTimeouts.get(timeoutKey);
    if (insufficientTimeout) {
      clearTimeout(insufficientTimeout);
      this.insufficientFundsTimeouts.delete(timeoutKey);
    }
    await this.clearInsufficientFundsMessage(game, playerId);

    // Lịch sử hành động
    this.addActionToHistory(game, playerId, 'raise', raiseAmount, newTotalBet);

    await this.moveToNextPlayer(game);

    return {
      success: true,
      message: `Pot Raise +${raiseAmount.toLocaleString()} 💸 (Total: ${newTotalBet.toLocaleString()} 💸)`,
      game,
    };
  }

  async makeAllIn(
    clanId: string,
    channelId: string,
    gameId: string,
    messageId: string,
    playerId: string,
  ): Promise<GameResult> {
    const game = await this.getActiveGame(clanId, channelId, gameId);
    if (!game) {
      return { success: false, message: 'Không có game nào đang diễn ra' };
    }

    // Xoá thông báo "Game mới đã bắt đầu!" nếu còn
    const gameKeyForStartMsg = this.createGameKey(clanId, channelId, gameId);
    const startedMsg = this.newGameStartedMessageIds.get(gameKeyForStartMsg);
    if (startedMsg) {
      await this.deleteChannelMessage(clanId, channelId, startedMsg);
      this.newGameStartedMessageIds.delete(gameKeyForStartMsg);
    }

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (currentPlayer.id !== playerId) {
      return { success: false, message: 'Không phải lượt của bạn' };
    }

    await this.deleteChannelMessage(clanId, channelId, messageId);

    if (currentPlayer.hasFolded) {
      return { success: false, message: 'Bạn đã fold' };
    }

    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });

    const userAmount = user?.amount || 0;
    const amountToCall = Math.max(
      0,
      game.currentBet - currentPlayer.currentBet,
    );
    if (userAmount <= 0) {
      return { success: false, message: 'Bạn không có tiền để all-in' };
    }

    if (amountToCall > 0 && userAmount < amountToCall) {
      const buttons: any[] = [];

      buttons.push({
        id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: `💸 Call (${amountToCall.toLocaleString('vi-VN')})`,
          style: EButtonMessageStyle.PRIMARY as any,
        },
      });

      // buttons.push({
      //   id: `poker_allin_${game.id}_${game.clanId}_${game.channelId}`,
      //   type: EMessageComponentType.BUTTON as any,
      //   component: {
      //     label: `🔥 All-in (${userAmount.toLocaleString('vi-VN')})`,
      //     style: EButtonMessageStyle.DANGER as any,
      //   },
      // });

      buttons.push({
        id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '📄 Fold',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      const components = [
        {
          components: buttons,
        },
      ];

      const sendMessage = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `⚠️ **Người chơi ${currentPlayer.name} Không đủ tiền để call mức hiện tại!**\n` +
          `💸 Cần để Call: ${amountToCall.toLocaleString()} 💸\n` +
          `💸 Bạn có: ${userAmount.toLocaleString()} 💸\n` +
          `💸 Thiếu: ${(amountToCall - userAmount).toLocaleString()} 💸\n` +
          `🎯 **Lựa chọn của bạn:**\n- 💸 Call (nếu bạn kiếm thêm tiền)\n- 🔥 All-in (đặt toàn bộ số hiện có)\n- 📄 Fold`,
        components,
      );

      // Lưu message và set timeout auto-fold sau 30s, giống call/raise
      if (sendMessage) {
        const gameKey = this.createGameKey(
          game.clanId,
          game.channelId,
          game.id,
        );
        const messageKey = `insufficient_${gameKey}_${playerId}`;
        this.insufficientFundsMessageIds.set(messageKey, sendMessage);
        const timeoutKey = `insufficient_${gameKey}_${playerId}`;
        const timeout = setTimeout(() => {
          this.handleInsufficientFundsTimeout(game, playerId);
        }, 30000);
        this.insufficientFundsTimeouts.set(timeoutKey, timeout);
      }

      return {
        success: false,
        message: `Không đủ tiền để call! Cần: ${amountToCall.toLocaleString()} 💸, Có: ${userAmount.toLocaleString()} 💸`,
      };
    }

    // Thực hiện all-in với toàn bộ số tiền của user
    const allInAmount = userAmount;
    const newPlayerBet = currentPlayer.currentBet + allInAmount;

    // Trừ toàn bộ tiền từ database user
    if (user) {
      user.amount = 0;
      await this.userRepository.save(user);
    }

    // Đặt toàn bộ tiền vào pot, stack tại bàn của người chơi trở về 0 (đánh dấu all-in)
    currentPlayer.chips = 0;
    currentPlayer.currentBet = newPlayerBet;
    currentPlayer.isAllIn = true; // Đánh dấu all-in thực sự
    game.pot += allInAmount;

    if (newPlayerBet > game.currentBet) {
      game.currentBet = newPlayerBet;
      game.hasRaiseInRound = true;
      game.lastAggressorIndex = game.currentPlayerIndex;

      this.setToActAfterRaise(game, playerId);

      // Kiểm tra và xử lý những người chơi không đủ tiền để call all-in
      await this.handleAllInInsufficientFunds(game, playerId);

      // Gọi moveToNextPlayer để tạo turn message cho người chơi tiếp theo
      await this.moveToNextPlayer(game);
    } else {
      // All-in không nâng mức cược, nhưng theo yêu cầu: reset lượt cho TẤT CẢ người chơi còn lại (trừ người all-in)
      this.setToActAfterRaise(game, playerId);
      game.lastAggressorIndex = game.currentPlayerIndex;

      // Thông báo và xử lý tình huống không đủ tiền cho người chơi khác tương tự khi có all-in
      await this.handleAllInInsufficientFunds(game, playerId);

      // Chuyển lượt cho người chơi tiếp theo
      await this.moveToNextPlayer(game);
    }

    await this.saveGameToDatabase(game);

    // Thêm action vào history
    this.addActionToHistory(game, playerId, 'allin', allInAmount, newPlayerBet);

    // Đã gọi moveToNextPlayer ở mỗi nhánh ở trên

    return {
      success: true,
      message: `All-in ${allInAmount.toLocaleString()} 💸!`,
      game,
    };
  }

  private async moveToNextPlayer(game: Game): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    await this.clearTurnTimeout(gameKey);

    // 1) Nếu chỉ còn 1 người chưa fold => kết thúc hand sớm
    let activePlayers = game.players.filter((p) => !p.hasFolded);
    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      await this.awardPotAndRotate(game, [winner.id]);
      return;
    }

    // 2) Kiểm tra những người KHÔNG ĐỦ tiền nhưng KHÔNG tự động fold ngay
    // Chỉ thông báo và cho timeout, người chơi vẫn có cơ hội tự quyết định
    // Nhưng vẫn tiếp tục chuyển lượt cho người chơi tiếp theo
    const insufficient = activePlayers.filter(
      (p) => p.chips < game.currentBet - p.currentBet,
    );
    // Không return ở đây nữa, để game có thể tiếp tục

    // 3) Kiểm tra điều kiện đóng round:
    const allMatched = activePlayers.every(
      (p) => p.currentBet === game.currentBet,
    );

    // Check if all players have acted

    if (game.toActIds.length === 0 && allMatched) {
      // Kiểm tra xem có người chơi nào all-in không
      const allInPlayers = activePlayers.filter((p) => p.isAllIn);

      if (allInPlayers.length > 0) {
        // Có người all-in, hiển thị kết quả ngay lập tức
        await this.handleAllInShowdown(game);
        return;
      } else {
        // Kiểm tra nếu đang ở round river, chuyển sang showdown
        if (game.round === 'river') {
          game.round = 'showdown';
          await this.saveGameToDatabase(game);
          await this.handleShowdown(game);
          return;
        } else {
          // Không có all-in, chuyển round bình thường
          await this.advanceToNextRound(game);
          return;
        }
      }
    }

    const nextIdx = this.findNextActorIndex(game, game.currentPlayerIndex);
    game.currentPlayerIndex = nextIdx;
    await this.saveGameToDatabase(game);
    await this.sendTurnActionButtons(game);
  }

  private async advanceToNextRound(game: Game): Promise<void> {
    const previousRound = game.round;

    game.hasRaiseInRound = false; // Reset raise flag for new round
    game.lastAggressorIndex = null;

    // Xóa action history khi chuyển round
    game.actionHistory = [];

    // Advance round
    switch (game.round) {
      case 'preflop':
        game.round = 'flop';

        if (this.ENABLE_REVEAL_DELAY) {
          await this.delay(this.REVEAL_DELAY_MS);
        }
        game.burned.push(game.deck.pop()!);
        for (let i = 0; i < 3; i++) {
          const card = game.deck.pop();
          if (card) game.board.push(card);
        }

        // Thiết lập lại toActIds cho round flop
        this.setToActForNewRound(game);
        break;

      case 'flop':
        game.round = 'turn';

        if (this.ENABLE_REVEAL_DELAY) {
          await this.delay(this.REVEAL_DELAY_MS);
        }
        game.burned.push(game.deck.pop()!);
        const turnCard = game.deck.pop();
        if (turnCard) game.board.push(turnCard);

        // Thiết lập lại toActIds cho round turn
        this.setToActForNewRound(game);
        break;

      case 'turn':
        game.round = 'river';

        if (this.ENABLE_REVEAL_DELAY) {
          await this.delay(this.REVEAL_DELAY_MS);
        }
        game.burned.push(game.deck.pop()!);
        const riverCard = game.deck.pop();
        if (riverCard) game.board.push(riverCard);

        // Thiết lập lại toActIds cho round river
        this.setToActForNewRound(game);
        break;

      case 'river':
        // Không kết thúc ngay, tiếp tục round river cho đến khi tất cả người chơi đã hành động
        // Game sẽ kết thúc khi tất cả người chơi đã hành động xong trong round river
        break;

      case 'showdown':
        // Kết thúc game khi đã hoàn thành tất cả các round
        await this.handleShowdown(game);
        return;

      default:
        return;
    }

    // Tìm người chơi đầu tiên sau dealer button
    game.currentPlayerIndex = this.findNextActivePlayer(
      game,
      game.dealerButton,
    );

    await this.saveGameToDatabase(game);

    // Gửi thông báo board mới
    if (game.round === 'flop') {
      const dealerLine = '';
    } else if (game.round === 'turn') {
      //       const dealerLine = '';
      //       await this.sendChannelMessage(
      //         game.clanId,
      //         game.channelId,
      //         `🔥 Turn: [ ${game.board[3]} ]
      // ${dealerLine}🂠 Board: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ${game.board[3]} ]
      // 💸 Pot: ${game.pot} | Mức cược hiện tại: ${game.currentBet}`,
      //       );
    } else if (game.round === 'river') {
      // Không kết thúc ngay, tiếp tục round river
      // Game sẽ kết thúc khi tất cả người chơi đã hành động xong
    }

    await this.sendPrivatePlayerCardsByRank(game);

    await this.sendTurnActionButtons(game);
  }

  // Mở toàn bộ các lá bài cộng đồng còn lại (dùng cho tình huống all-in)
  private async revealRemainingBoard(game: Game): Promise<void> {
    // Nếu chưa có lá flop nào
    if (game.board.length === 0 && game.round !== 'showdown') {
      // Burn + 3 lá flop
      if (game.deck.length >= 4) {
        game.burned.push(game.deck.pop()!);
        for (let i = 0; i < 3; i++) {
          const card = game.deck.pop();
          if (card) game.board.push(card);
        }
      }
      game.round = 'flop';
    }

    // Nếu đã có flop (3 lá), cần mở turn
    if (game.board.length === 3 && game.round !== 'showdown') {
      if (game.deck.length >= 2) {
        game.burned.push(game.deck.pop()!);
        const turnCard = game.deck.pop();
        if (turnCard) game.board.push(turnCard);
      }
      game.round = 'turn';
    }

    // Nếu đã có turn (4 lá), cần mở river
    if (game.board.length === 4 && game.round !== 'showdown') {
      if (game.deck.length >= 2) {
        game.burned.push(game.deck.pop()!);
        const riverCard = game.deck.pop();
        if (riverCard) game.board.push(riverCard);
      }
      game.round = 'river';
    }

    // Sau khi mở đủ 5 lá, đánh dấu là sẵn sàng showdown
    if (game.board.length === 5) {
      game.round = 'river';
    }
  }

  private findNextActivePlayer(game: Game, startIndex: number): number {
    for (let i = 1; i <= game.players.length; i++) {
      const index = (startIndex + i) % game.players.length;
      const player = game.players[index];
      if (!player.hasFolded) {
        return index;
      }
    }
    return startIndex; // Fallback
  }

  // === NEW: điều phối vòng cược theo chuẩn Hold'em ===
  private setToActForNewRound(game: Game) {
    game.toActIds = game.players.filter((p) => !p.hasFolded).map((p) => p.id);
  }

  private setToActAfterRaise(game: Game, raiserId: string) {
    game.toActIds = game.players
      .filter((p) => !p.hasFolded && p.id !== raiserId)
      .map((p) => p.id);
  }

  private removeFromToAct(game: Game, playerId: string) {
    game.toActIds = game.toActIds.filter((id) => id !== playerId);
  }

  private findNextActorIndex(game: Game, startIndex: number): number {
    const n = game.players.length;
    // Ưu tiên người vẫn còn “toAct”
    for (let i = 1; i <= n; i++) {
      const idx = (startIndex + i) % n;
      const p = game.players[idx];
      if (!p.hasFolded && game.toActIds.includes(p.id)) return idx;
    }
    for (let i = 1; i <= n; i++) {
      const idx = (startIndex + i) % n;
      const p = game.players[idx];
      if (!p.hasFolded) return idx;
    }
    return startIndex;
  }

  private async handleShowdown(game: Game): Promise<void> {
    try {
      const contenders = game.players.filter((p) => !p.hasFolded);
      if (contenders.length === 0) {
        // Không hợp lệ, kết thúc hand
        await this.sendChannelMessage(
          game.clanId,
          game.channelId,
          `🎭 Showdown: không còn ai hợp lệ. Pot hoàn về nhà cái.`,
        );
        await this.resetForNextHand(game);
        return;
      }

      const ranked = contenders
        .map((p) => {
          const hand = [...p.hole, ...game.board];
          const rank = this.calculateHandRank(hand);
          return {
            player: p,
            rank,
            hand,
          };
        })
        .sort((a, b) => {
          if (a.rank.rank !== b.rank.rank) {
            return b.rank.rank - a.rank.rank; // Rank cao hơn lên trước
          }
          // Nếu cùng rank, so sánh kicker
          for (
            let i = 0;
            i < Math.min(a.rank.kickers.length, b.rank.kickers.length);
            i++
          ) {
            if (a.rank.kickers[i] !== b.rank.kickers[i]) {
              return b.rank.kickers[i] - a.rank.kickers[i];
            }
          }
          return 0;
        });

      const winner = ranked[0].player;
      const winners = [winner];

      let showdownMessage = `🎭 Kết quả cuối cùng:\nBoard: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ${game.board[3]} ${game.board[4]} ] \n`;

      ranked.forEach((item, index) => {
        const { player, rank } = item;
        const rankName = this.getRankName(rank.rank);
        const cards = player.hole.map((card) => `[${card}]`).join(' ');
        const position = index + 1;

        showdownMessage += `${position}. **${player.name}**: ${cards} - *${rankName}*\n`;
      });

      await this.awardPotAndRotate(
        game,
        winners.map((w) => w.id),
        showdownMessage,
      );
    } catch (e) {
      await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `❌ Lỗi showdown: ${(e as Error).message}`,
      );
      await this.resetForNextHand(game);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async awardPotAndRotate(
    game: Game,
    winnerIds: string[],
    showdownMessage?: string,
  ): Promise<void> {
    if (winnerIds.length === 0) {
      await this.resetForNextHand(game);
      return;
    }

    // Kiểm tra xem game đã được xử lý chưa để tránh duplicate messages
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    if (!this.activeGames.has(gameKey)) {
      return;
    }

    // Không xóa game khỏi activeGames ngay lập tức, để resetForNextHand có thể hoạt động
    // this.activeGames.delete(gameKey);
    // this.gameInvites.delete(gameKey);

    const totalWinnings = game.pot;

    // Plan A: Trả tiền thắng trực tiếp vào DB, không qua chips
    for (const player of game.players) {
      if (winnerIds.includes(player.id)) {
        await this.addMoneyToUser(player.id, totalWinnings);
        break;
      }
    }

    const winner = game.players.find((p) => winnerIds.includes(p.id));
    const winnerName = winner?.name || 'Unknown';

    let winningHand = 'High Card (Mậu thầu)';
    if (winner) {
      const hand = [...winner.hole, ...game.board];
      const rank = this.calculateHandRank(hand);
      winningHand = this.getRankName(rank.rank);
    }

    await this.sendChannelMessage(
      game.clanId,
      game.channelId,
      `${showdownMessage || ''} 🏆 **Người thắng:** ${winnerName} với **${winningHand}**!\n` +
        `💸 Nhận được: **${totalWinnings.toLocaleString()}** token`,
    );

    // Sau khi hiển thị kết quả, gọi resetForNextHand để hiển thị button continue
    await this.resetForNextHand(game);
  }

  private async addMoneyToUser(
    playerId: string,
    amount: number,
  ): Promise<void> {
    try {
      const user = await this.userRepository.findOne({
        where: { user_id: playerId },
      });

      if (user) {
        const oldAmount = user.amount;
        user.amount += amount;
        await this.userRepository.save(user);
      }
    } catch (error) {
      console.error('Error adding money to user:', error);
    }
  }

  private async resetForNextHand(game: Game): Promise<void> {
    // Plan A: Không cash-out chips (chips luôn 0); chỉ reset state
    game.board = [];
    game.burned = [];
    game.pot = 0;
    game.currentBet = 0;
    game.round = 'waiting';
    for (const p of game.players) {
      p.hole = [];
      p.hasFolded = false;
      p.currentBet = 0;
      p.isAllIn = false;
      p.chips = 0; // Reset chips về 0
    }

    // Tạo bộ bài mới
    game.deck = this.createDeck();
    this.shuffleDeck(game.deck);

    // Kết thúc game sau khi có kết quả showdown
    game.isActive = false;
    await this.saveGameToDatabase(game);

    // Xóa game khỏi activeGames và cleanup timeout
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    this.activeGames.delete(gameKey);
    this.gameInvites.delete(gameKey);

    await this.clearTurnTimeout(gameKey);
    for (const player of game.players) {
      const timeoutKey = `insufficient_${gameKey}_${player.id}`;
      const insufficientTimeout =
        this.insufficientFundsTimeouts.get(timeoutKey);
      if (insufficientTimeout) {
        clearTimeout(insufficientTimeout);
        this.insufficientFundsTimeouts.delete(timeoutKey);
      }
    }

    // Xóa thông tin continue game cũ trước khi tạo mới
    this.cleanupContinueGameData(gameKey);

    // Hiển thị button để người chơi chọn tiếp tục chơi ván mới
    await this.sendContinueGameButtons(game);
  }

  async sendChannelMessage(
    clanId: string,
    channelId: string,
    content: string,
    components?: any[],
    user_id?: string,
    user_name?: string,
  ): Promise<string | null> {
    try {
      const client = this.mezonClientService.getClient();
      const clan = client.clans.get(clanId);
      const channel = await clan?.channels.fetch(channelId);

      if (channel) {
        const messagePayload: any = { t: content };
        if (components) {
          messagePayload.components = components;
        }
        messagePayload.mk = [
          { type: EMarkdownType.PRE, s: 0, e: content.length },
        ];
        messagePayload.allow_mentions = true;

        console.log('user_id', user_id);
        if (user_id) {
          messagePayload.mentions = [
            {
              user_id: user_id,
              s: content.indexOf(`@${user_name}`),
              e: content.length,
            },
          ];
          messagePayload.allow_mentions = true;
          messagePayload.allow_user_mentions = true;
          messagePayload.mode = 2;
          messagePayload.code = 0;
        }

        const message = await (channel as any).send(messagePayload);

        return message?.message_id || null;
      } else {
        console.error('❌ Channel not found:', channelId);
      }
    } catch (error) {
      console.error('❌ Lỗi gửi tin nhắn channel:', error);
    }
    return null;
  }

  async editChannelMessage(
    clanId: string,
    channelId: string,
    messageId: string,
    content: string,
    components?: any[],
  ): Promise<void> {
    try {
      const client = this.mezonClientService.getClient();
      const clan = client.clans.get(clanId);
      const channel = await clan?.channels.fetch(channelId);
      const messagesChannel = await channel?.messages.fetch(messageId);

      if (channel) {
        const messagePayload: any = {
          t: content,
          mk: [{ type: EMarkdownType.PRE, s: 0, e: content.length }],
        };
        if (components) {
          messagePayload.components = components;
        }

        await messagesChannel?.update(messagePayload);
      } else {
      }
    } catch (error) {
      console.error('❌ Lỗi edit tin nhắn channel:', error);
    }
  }

  async deleteChannelMessage(
    clanId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    try {
      const client = this.mezonClientService.getClient();
      const clan = client.clans.get(clanId);
      const channel = await clan?.channels.fetch(channelId);
      const messagesChannel = await channel?.messages.fetch(messageId);
      await messagesChannel?.delete();
    } catch (error) {}
  }

  async replyChannelMessage(
    clanId: string,
    channelId: string,
    messageId: string,
    content: string,
    components?: any[],
  ): Promise<void> {
    try {
      const client = this.mezonClientService.getClient();
      const clan = client.clans.get(clanId);
      const channel = await clan?.channels.fetch(channelId);
      const messagesChannel = await channel?.messages.fetch(messageId);

      if (channel) {
        const messagePayload: any = {
          t: content,
          mk: [{ type: EMarkdownType.PRE, s: 0, e: content.length }],
        };
        if (components) {
          messagePayload.components = components;
        }

        await messagesChannel?.reply(messagePayload);
      } else {
      }
    } catch (error) {
      console.error('❌ Lỗi edit tin nhắn channel:', error);
    }
  }

  async sendPrivateMessage(
    userId: string,
    content: string,
    clanId?: string,
    channelId?: string,
    components?: any[],
  ): Promise<void> {
    try {
      if (clanId && channelId) {
        const client = this.mezonClientService.getClient();
        const clan = client.clans.get(clanId);
        const channel = await clan?.channels.fetch(channelId);

        if (channel) {
          await channel.sendEphemeral(userId, {
            mk: [{ type: EMarkdownType.PRE, s: 0, e: content.length }],
            t: content,
            components: components,
          });
        }
      }
    } catch (error) {
      console.error('Error sending private message:', error);
      throw error;
    }
  }

  async sendTurnActionButtons(game: Game): Promise<void> {
    const currentPlayer = game.players[game.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.hasFolded) {
      return;
    }

    // Không gửi nút hành động cho người chơi đã all-in
    if (currentPlayer.isAllIn) {
      return;
    }

    try {
      // Xóa timeout cũ nếu có
      const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
      const oldTimeout = this.turnTimeouts.get(gameKey);
      if (oldTimeout) {
        clearTimeout(oldTimeout);
      }

      // Xóa insufficient funds timeout nếu người chơi hiện tại có đủ tiền
      const user = await this.userRepository.findOne({
        where: { user_id: currentPlayer.id },
      });
      const userAmount = user?.amount || 0;
      const callAmount = Math.max(
        0,
        game.currentBet - currentPlayer.currentBet,
      );

      if (userAmount >= callAmount) {
        const timeoutKey = `insufficient_${gameKey}_${currentPlayer.id}`;
        const insufficientTimeout =
          this.insufficientFundsTimeouts.get(timeoutKey);
        if (insufficientTimeout) {
          clearTimeout(insufficientTimeout);
          this.insufficientFundsTimeouts.delete(timeoutKey);
        }
      }

      const canCheck = currentPlayer.currentBet >= game.currentBet;
      const callAmountButtons = Math.max(
        0,
        game.currentBet - currentPlayer.currentBet,
      );

      const buttons: any[] = [];

      // Kiểm tra xem có người chơi nào all-in không
      const hasAnyAllIn = game.players.some((p) => !p.hasFolded && p.isAllIn);

      // 1. CHECK BUTTON - Ẩn khi có người all-in (chỉ cho phép call/fold)
      if (canCheck && !hasAnyAllIn) {
        buttons.push({
          id: `poker_check_${game.id}_${game.clanId}_${game.channelId}`,
          type: EMessageComponentType.BUTTON as any,
          component: {
            label: '👁️ Check',
            style: EButtonMessageStyle.SECONDARY as any,
          },
        });
      }

      // 1.1. CALL BUTTON - hiển thị khi cần call (thay thế Check nếu không thể check)
      // Hiển thị luôn nếu có callAmount > 0, không cần kiểm tra chips
      if (!canCheck && callAmountButtons > 0) {
        buttons.push({
          id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
          type: EMessageComponentType.BUTTON as any,
          component: {
            label: `💸 Call (${callAmountButtons})`,
            style: EButtonMessageStyle.PRIMARY as any,
          },
        });
      }

      // 2. RAISE BUTTONS (quick options) - Ẩn khi bàn có người all-in
      if (!hasAnyAllIn) {
        // Lấy số dư DB để ẩn các nút raise khi không đủ tiền
        let userAmountForButtons = 0;
        try {
          const dbUserForButtons = await this.userRepository.findOne({
            where: { user_id: currentPlayer.id },
          });
          userAmountForButtons = dbUserForButtons?.amount || 0;
        } catch (_) {}
        const baseRaise = game.betAmount;
        const totalAfterRaise1 = game.currentBet + baseRaise;
        const need1 = totalAfterRaise1 - currentPlayer.currentBet;

        if (need1 > 0 && userAmountForButtons >= need1) {
          buttons.push({
            id: `poker_raise1_${game.id}_${game.clanId}_${game.channelId}`,
            type: EMessageComponentType.BUTTON as any,
            component: {
              label: `💸 Raise (+${baseRaise})`,
              style: EButtonMessageStyle.SUCCESS as any,
            },
          });
        }

        const totalAfterRaise2 = game.currentBet + baseRaise * 2;
        const need2 = totalAfterRaise2 - currentPlayer.currentBet;
        if (need2 > 0 && userAmountForButtons >= need2) {
          buttons.push({
            id: `poker_raise2_${game.id}_${game.clanId}_${game.channelId}`,
            type: EMessageComponentType.BUTTON as any,
            component: {
              label: `💸 Raise (+${baseRaise * 2})`,
              style: EButtonMessageStyle.SUCCESS as any,
            },
          });
        }

        const potRaise = Math.max(baseRaise, game.pot);
        const totalAfterPot = game.currentBet + potRaise;
        const needPot = totalAfterPot - currentPlayer.currentBet;
        // Ẩn nút Raise Pot nếu số dư không đủ
        if (needPot > 0 && userAmountForButtons >= needPot) {
          buttons.push({
            id: `poker_raisepot_${game.id}_${game.clanId}_${game.channelId}`,
            type: EMessageComponentType.BUTTON as any,
            component: {
              label: `🏺 Pot Raise (+${potRaise})`,
              style: EButtonMessageStyle.PRIMARY as any,
            },
          });
        }

        // Bỏ nút Tùy chỉnh theo yêu cầu
      }

      // 3. ALL-IN BUTTON - hiển thị nếu user có amount >= 1 trong database
      try {
        const user = await this.userRepository.findOne({
          where: { user_id: currentPlayer.id },
        });

        const userAmount = user?.amount || 0;

        if (userAmount >= 1) {
          buttons.push({
            id: `poker_allin_${game.id}_${game.clanId}_${game.channelId}`,
            type: EMessageComponentType.BUTTON as any,
            component: {
              label: `🔥 All-in (${userAmount.toLocaleString()})`,
              style: EButtonMessageStyle.DANGER as any,
            },
          });
        }
      } catch (error) {
        console.error('Error fetching user amount for All-in button:', error);
      }

      buttons.push({
        id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
        type: EMessageComponentType.BUTTON as any,
        component: {
          label: '📄 Fold',
          style: EButtonMessageStyle.SECONDARY as any,
        },
      });

      const components = [
        {
          components: buttons,
        },
      ];

      const dealerLine = '';

      let boardDisplay = '';
      if (game.board.length === 0 || game.round === 'preflop') {
        boardDisplay = '🂠 Board: [ ___ ___ ___ ] (Chưa mở bài)';
      } else if (game.round === 'flop') {
        boardDisplay = `🂠 Board: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ]`;
      } else if (game.round === 'turn') {
        boardDisplay = `🂠 Board: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ${game.board[3]} ]`;
      } else if (game.round === 'river') {
        boardDisplay = `🂠 Board: [ ${game.board.join(' ')} ]`;
      }

      const actionHistory = this.formatActionHistory(game);

      const messageContent = `👉 @${currentPlayer.name} Chọn — hành động: ${hasAnyAllIn ? 'call/fold' : 'check/call/raise/fold'} | ⏰ 30s ⚠️ **Auto FOLD nếu không click button!**
👉  Lượt Tiếp: ${game.players[game.dealerButton]?.name} | SB: ${game.players[game.dealerButton]?.name} | BB: ${game.players[(game.dealerButton + 1) % game.players.length]?.name}
💸 Pot: ${game.pot.toLocaleString('vi-VN')} | Mức cược hiện tại: ${game.currentBet.toLocaleString('vi-VN')}
${dealerLine}${boardDisplay}${actionHistory}
`;

      const existingMessageId = this.turnMessageIds.get(gameKey);

      if (existingMessageId) {
        try {
          await this.deleteChannelMessage(
            game.clanId,
            game.channelId,
            existingMessageId,
          );
        } catch (_) {}
      }

      const newMessageId = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        messageContent,
        components,
        currentPlayer.id,
        currentPlayer.name,
      );

      if (newMessageId) {
        this.turnMessageIds.set(gameKey, newMessageId);
      }

      // Set timeout cho lượt này (30 giây)
      const turnTimeout = setTimeout(async () => {
        await this.handleTurnTimeout(game, currentPlayer.id);
      }, this.TURN_TIMEOUT);

      this.turnTimeouts.set(gameKey, turnTimeout);
    } catch (error) {
      console.error('Error sending turn action buttons:', error);
    }
  }

  private async handleTurnTimeout(game: Game, playerId: string): Promise<void> {
    try {
      const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);

      // Xóa turn message khi hết thời gian
      const turnMessageId = this.turnMessageIds.get(gameKey);
      if (turnMessageId) {
        await this.deleteChannelMessage(
          game.clanId,
          game.channelId,
          turnMessageId,
        );
        this.turnMessageIds.delete(gameKey);
      }

      // Xóa insufficient funds message của user hết thời gian
      await this.clearInsufficientFundsMessage(game, playerId);

      const player = game.players[game.currentPlayerIndex];
      if (player && player.id === playerId && !player.hasFolded) {
        await this.makeFold(game.clanId, game.channelId, game.id, playerId);
        await this.sendChannelMessage(
          game.clanId,
          game.channelId,
          `⏰ <@${player.name}> đã hết thời gian (30s) không có tương tác — **AUTO FOLD**!`,
        );
      }
      this.turnTimeouts.delete(gameKey);
    } catch (error) {
      console.error('Error handling turn timeout:', error);
    }
  }

  private async clearTurnTimeout(gameKey: string): Promise<void> {
    const timeout = this.turnTimeouts.get(gameKey);
    if (timeout) {
      clearTimeout(timeout);
      this.turnTimeouts.delete(gameKey);
    }

    const turnMessageId = this.turnMessageIds.get(gameKey);
    if (turnMessageId) {
      const parts = gameKey.split('_');
      if (parts.length >= 3) {
        const clanId = parts[0];
        const channelId = parts[1];
        await this.deleteChannelMessage(clanId, channelId, turnMessageId);
      }
      this.turnMessageIds.delete(gameKey);
    }
  }

  private async dealCardsAndStartGame(gameKey: string): Promise<void> {
    const game = this.activeGames.get(gameKey);
    if (!game) {
      return;
    }

    try {
      // Khi bắt đầu chia bài, nếu có message "Game mới đã được tạo!" thì xoá đi
      const createdMsgId = this.newGameCreatedMessageIds.get(gameKey);
      if (createdMsgId) {
        await this.deleteChannelMessage(
          game.clanId,
          game.channelId,
          createdMsgId,
        );
        this.newGameCreatedMessageIds.delete(gameKey);
      }

      // Gửi thông báo "Game mới đã bắt đầu!" và lưu messageId
      const startedMsgId = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `🎰 **Game mới đã bắt đầu!** Với ${game.players.length} người chơi.`,
      );
      if (startedMsgId) {
        this.newGameStartedMessageIds.set(gameKey, startedMsgId);
      }

      // Phát bài cho players
      for (let i = 0; i < 2; i++) {
        for (const player of game.players) {
          const card = game.deck.pop();
          if (card) player.hole.push(card);
        }
      }

      // Gửi bài cho từng người chơi bằng sendEphemeral
      for (const player of game.players) {
        try {
          await this.sendPrivateMessage(
            player.id,
            `🎲 **Bài của bạn**: ${player.hole.join(' ')}`,
            game.clanId,
            game.channelId,
          );
        } catch (dmError) {
          console.error(`Không thể gửi bài cho ${player.id}:`, dmError);
        }
      }

      game.round = 'preflop';
      this.postBlinds(game);

      await this.sendTurnActionButtons(game);

      // Lưu game state
      await this.saveGameToDatabase(game);

      // Xóa message "Game mới đã bắt đầu!" sau khi đã gửi bài riêng cho từng người chơi
      const startedMsgToDelete = this.newGameStartedMessageIds.get(gameKey);
      if (startedMsgToDelete) {
        await this.deleteChannelMessage(
          game.clanId,
          game.channelId,
          startedMsgToDelete,
        );
        this.newGameStartedMessageIds.delete(gameKey);
      }

      // Xóa timeout
      const timeout = this.gameTimeouts.get(gameKey);
      if (timeout) {
        clearTimeout(timeout);
        this.gameTimeouts.delete(gameKey);
      }

      // Action buttons đã được gửi ở trên
    } catch (error) {
      console.error('Error dealing cards:', error);
    }
  }

  private createDeck(): string[] {
    const deck: string[] = [];
    for (const suit of this.SUITS) {
      for (const rank of this.RANKS) {
        deck.push(`${rank}${suit}`);
      }
    }
    return deck;
  }

  private shuffleDeck(deck: string[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }

  private postBlinds(game: Game): void {
    // Vòng đầu tiên không có blinds - tất cả người chơi đều bắt đầu với bet = 0
    for (const player of game.players) {
      player.currentBet = 0;
    }

    game.currentBet = 0;

    game.currentPlayerIndex = (game.dealerButton + 1) % game.players.length;

    this.setToActForNewRound(game);
    game.lastAggressorIndex = null;
  }

  private async saveGameToDatabase(game: Game): Promise<void> {
    try {
      const existingGame = await this.pokerGameRepository.findOne({
        where: {
          clanId: game.clanId,
          channelId: game.channelId,
          isActive: true,
        },
      });

      if (existingGame) {
        await this.pokerGameRepository.update(existingGame.id, {
          gameState: game as any,
          updatedAt: new Date(),
        });
      } else {
        const pokerGame = new PokerGame();
        pokerGame.clanId = game.clanId;
        pokerGame.channelId = game.channelId;
        pokerGame.creatorId = game.players[0].id;
        pokerGame.gameState = game as any;
        pokerGame.isActive = true;

        await this.pokerGameRepository.save(pokerGame);
      }
    } catch (error) {
      console.error('Error saving game to database:', error);
    }
  }
  private async sendPrivatePlayerCardsByRank(game: Game): Promise<void> {
    try {
      // Lấy danh sách người chơi còn lại (chưa fold)
      const activePlayers = game.players.filter((p) => !p.hasFolded);
      if (activePlayers.length === 0) return;

      for (const player of activePlayers) {
        try {
          const hand = [...player.hole, ...game.board];
          const rank = this.calculateHandRank(hand);
          const rankName = this.getRankName(rank.rank);
          const cards = player.hole.map((card) => `[${card}]`).join(' ');

          const privateMessage =
            `🃏 **Đánh giá bài của bạn:**\n` +
            `Bài của bạn: ${cards}\n` +
            `Xếp hạng: *${rankName}*`;

          await this.sendPrivateMessage(
            player.id,
            privateMessage,
            game.clanId,
            game.channelId,
          );
        } catch (dmError) {
          console.error(`Không thể gửi bài cho ${player.id}:`, dmError);
        }
      }
    } catch (error) {
      console.error('Error sending player cards by rank:', error);
    }
  }

  private calculateHandRank(hand: string[]): {
    rank: number;
    kickers: number[];
  } {
    const bestHand = this.getBestFiveCardHand(hand);

    const values = bestHand.map((card) => this.getCardValue(card));
    const suits = bestHand.map((card) => this.getCardSuit(card));

    values.sort((a, b) => b - a);

    const counts: { [key: number]: number } = {};
    values.forEach((value) => {
      counts[value] = (counts[value] || 0) + 1;
    });

    const pairs = Object.entries(counts).filter(([_, count]) => count === 2);
    const threes = Object.entries(counts).filter(([_, count]) => count === 3);
    const fours = Object.entries(counts).filter(([_, count]) => count === 4);

    // Kiểm tra flush (5 lá cùng chất)
    const isFlush = this.isFlush(suits);

    // Kiểm tra straight (5 lá liên tiếp)
    const straightInfo = this.isStraight(values);
    const isStraight = straightInfo.isStraight;

    // 1. Royal Flush (10-J-Q-K-A cùng chất)
    if (isFlush && isStraight && values[0] === 14 && values[1] === 13) {
      return { rank: 10, kickers: [14] }; // Royal Flush
    }

    // 2. Straight Flush (5 lá liên tiếp cùng chất)
    if (isFlush && isStraight) {
      return { rank: 9, kickers: [straightInfo.highCard] }; // Straight Flush
    }

    // 3. Four of a Kind (Tứ quý)
    if (fours.length > 0) {
      const fourValue = parseInt(fours[0][0]);
      const kicker = values.find((v) => v !== fourValue) || 0;
      return { rank: 8, kickers: [fourValue, kicker] }; // Four of a kind
    }

    // 4. Full House (Cù lũ)
    if (threes.length > 0 && pairs.length > 0) {
      return {
        rank: 7,
        kickers: [parseInt(threes[0][0]), parseInt(pairs[0][0])],
      }; // Full house
    }

    // 5. Flush (Thùng)
    if (isFlush) {
      return { rank: 6, kickers: values }; // Flush
    }

    // 6. Straight (Sảnh)
    if (isStraight) {
      return { rank: 5, kickers: [straightInfo.highCard] }; // Straight
    }

    // 7. Three of a Kind (Bộ ba)
    if (threes.length > 0) {
      const threeValue = parseInt(threes[0][0]);
      const kickers = values.filter((v) => v !== threeValue).slice(0, 2);
      return { rank: 4, kickers: [threeValue, ...kickers] }; // Three of a kind
    }

    // 8. Two Pair (Hai đôi)
    if (pairs.length >= 2) {
      const pairValues = pairs
        .map(([value, _]) => parseInt(value))
        .sort((a, b) => b - a);
      const kicker = values.find((v) => !pairValues.includes(v)) || 0;
      return { rank: 3, kickers: [...pairValues, kicker] }; // Two pair
    }

    // 9. One Pair (Một đôi)
    if (pairs.length === 1) {
      const pairValue = parseInt(pairs[0][0]);
      const kickers = values.filter((v) => v !== pairValue).slice(0, 3);
      return { rank: 2, kickers: [pairValue, ...kickers] }; // One pair
    }

    // 10. High Card (Mậu thầu)
    return { rank: 1, kickers: values }; // High card
  }

  private getBestFiveCardHand(hand: string[]): string[] {
    // Nếu đúng 5 lá thì trả về luôn
    if (hand.length === 5) {
      return hand;
    }

    // Nếu có 6 lá hoặc 7 lá, tìm combo 5 lá tốt nhất
    if (hand.length >= 6) {
      let bestHand = hand.slice(0, 5);
      let bestRank = this.evaluateBasicHand(bestHand);

      // Thử tất cả combo 5 lá từ hand
      for (let i = 0; i < hand.length - 4; i++) {
        for (let j = i + 1; j < hand.length - 3; j++) {
          for (let k = j + 1; k < hand.length - 2; k++) {
            for (let l = k + 1; l < hand.length - 1; l++) {
              for (let m = l + 1; m < hand.length; m++) {
                const combo = [hand[i], hand[j], hand[k], hand[l], hand[m]];
                const rank = this.evaluateBasicHand(combo);

                if (this.compareHands(rank, bestRank) > 0) {
                  bestHand = combo;
                  bestRank = rank;
                }
              }
            }
          }
        }
      }

      return bestHand;
    }

    // Fallback cho các trường hợp khác (ít hơn 5 lá)
    return hand.slice(0, Math.min(5, hand.length));
  }

  private evaluateBasicHand(hand: string[]): {
    rank: number;
    kickers: number[];
  } {
    const values = hand.map((card) => this.getCardValue(card));
    const suits = hand.map((card) => this.getCardSuit(card));
    values.sort((a, b) => b - a);

    const counts: { [key: number]: number } = {};
    values.forEach((value) => {
      counts[value] = (counts[value] || 0) + 1;
    });

    const pairs = Object.entries(counts).filter(([_, count]) => count === 2);
    const threes = Object.entries(counts).filter(([_, count]) => count === 3);
    const fours = Object.entries(counts).filter(([_, count]) => count === 4);

    const isFlush = this.isFlush(suits);
    const straightInfo = this.isStraight(values);
    const isStraight = straightInfo.isStraight;

    if (isFlush && isStraight && values[0] === 14 && values[1] === 13) {
      return { rank: 10, kickers: [14] };
    }
    if (isFlush && isStraight) {
      return { rank: 9, kickers: [straightInfo.highCard] };
    }
    if (fours.length > 0) {
      return { rank: 8, kickers: [parseInt(fours[0][0])] };
    }
    if (threes.length > 0 && pairs.length > 0) {
      return {
        rank: 7,
        kickers: [parseInt(threes[0][0]), parseInt(pairs[0][0])],
      };
    }
    if (isFlush) {
      return { rank: 6, kickers: values };
    }
    if (isStraight) {
      return { rank: 5, kickers: [straightInfo.highCard] };
    }
    if (threes.length > 0) {
      return { rank: 4, kickers: [parseInt(threes[0][0])] };
    }
    if (pairs.length >= 2) {
      const pairValues = pairs
        .map(([value, _]) => parseInt(value))
        .sort((a, b) => b - a);
      return { rank: 3, kickers: pairValues };
    }
    if (pairs.length === 1) {
      return { rank: 2, kickers: [parseInt(pairs[0][0])] };
    }
    return { rank: 1, kickers: values };
  }

  private compareHands(
    hand1: { rank: number; kickers: number[] },
    hand2: { rank: number; kickers: number[] },
  ): number {
    if (hand1.rank !== hand2.rank) {
      return hand1.rank - hand2.rank;
    }

    for (
      let i = 0;
      i < Math.min(hand1.kickers.length, hand2.kickers.length);
      i++
    ) {
      if (hand1.kickers[i] !== hand2.kickers[i]) {
        return hand1.kickers[i] - hand2.kickers[i];
      }
    }

    return 0;
  }

  private getCardValue(card: string): number {
    // Lấy phần value trước phần hậu tố chất (hỗ trợ suit gồm nhiều codepoint như ♠️)
    const suit = this.getCardSuit(card);
    const value = card.slice(0, card.length - suit.length);
    switch (value) {
      case 'A':
        return 14;
      case 'K':
        return 13;
      case 'Q':
        return 12;
      case 'J':
        return 11;
      case '10': // deck hiện tại tạo '10'
      case 'T': // phòng trường hợp đổi ký hiệu
        return 10;
      default:
        return parseInt(value);
    }
  }

  private getCardSuit(card: string): string {
    // Tìm chất bằng cách so khớp hậu tố với danh sách SUITS (xử lý emoji có variation selector)
    for (const suit of this.SUITS) {
      if (card.endsWith(suit)) return suit;
    }
    // Fallback: lấy grapheme cuối cùng
    const chars = Array.from(card);
    return chars[chars.length - 1] || '';
  }

  private isFlush(suits: string[]): boolean {
    // Phải có đúng 5 lá và tất cả cùng chất
    return suits.length === 5 && new Set(suits).size === 1;
  }

  private isStraight(values: number[]): {
    isStraight: boolean;
    highCard: number;
  } {
    const uniqueValues = [...new Set(values)].sort((a, b) => b - a);

    if (uniqueValues.length !== 5) {
      return { isStraight: false, highCard: 0 };
    }

    // Kiểm tra straight thông thường
    let isStraight = true;
    for (let i = 0; i < 4; i++) {
      if (uniqueValues[i] - uniqueValues[i + 1] !== 1) {
        isStraight = false;
        break;
      }
    }

    if (isStraight) {
      return { isStraight: true, highCard: uniqueValues[0] };
    }

    // Kiểm tra straight A-2-3-4-5 (wheel)
    if (
      uniqueValues[0] === 14 &&
      uniqueValues[1] === 5 &&
      uniqueValues[2] === 4 &&
      uniqueValues[3] === 3 &&
      uniqueValues[4] === 2
    ) {
      return { isStraight: true, highCard: 5 }; // A-2-3-4-5 có high card là 5
    }

    return { isStraight: false, highCard: 0 };
  }

  private getRankName(rank: number): string {
    switch (rank) {
      case 10:
        return 'Royal Flush (Sảnh chúa)';
      case 9:
        return 'Straight Flush (Thùng phá sảnh)';
      case 8:
        return 'Four of a Kind (Tứ quý)';
      case 7:
        return 'Full House (Cù lũ)';
      case 6:
        return 'Flush (Thùng)';
      case 5:
        return 'Straight (Sảnh)';
      case 4:
        return 'Three of a Kind (Bộ ba)';
      case 3:
        return 'Two Pair (Hai đôi)';
      case 2:
        return 'One Pair (Một đôi)';
      case 1:
        return 'High Card (Mậu thầu)';
      default:
        return 'Unknown';
    }
  }

  private async handleAllInInsufficientFunds(
    game: Game,
    allInPlayerId: string,
  ): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const allInPlayer = game.players.find((p) => p.id === allInPlayerId);
    const allInPlayerName = allInPlayer?.name || 'Unknown';
    const nextIdx = this.findNextActorIndex(game, game.currentPlayerIndex);
    const nextActor = game.players[nextIdx];

    console.log('nextActor', nextActor);
    if (!nextActor) return;

    const callAmount = game.currentBet - nextActor.currentBet;

    const buttons: any[] = [];
    buttons.push({
      id: `poker_call_${game.id}_${game.clanId}_${game.channelId}`,
      type: EMessageComponentType.BUTTON as any,
      component: {
        label: `💸 Call (${callAmount.toLocaleString('vi-VN')}) token`,
        style: EButtonMessageStyle.PRIMARY as any,
      },
    });
    buttons.push({
      id: `poker_fold_${game.id}_${game.clanId}_${game.channelId}`,
      type: EMessageComponentType.BUTTON as any,
      component: {
        label: '📄 Fold',
        style: EButtonMessageStyle.SECONDARY as any,
      },
    });

    const components = [
      {
        components: buttons,
      },
    ];

    let boardDisplay = '';
    if (game.board.length === 0 || game.round === 'preflop') {
      boardDisplay = '🂠 Board: [ ___ ___ ___ ] (Chưa mở bài)';
    } else if (game.round === 'flop') {
      boardDisplay = `🂠 Board: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ]`;
    } else if (game.round === 'turn') {
      boardDisplay = `🂠 Board: [ ${game.board[0]} ${game.board[1]} ${game.board[2]} ${game.board[3]} ]`;
    } else if (game.round === 'river') {
      boardDisplay = `🂠 Board: [ ${game.board.join(' ')} ]`;
    }

    const header = `🔥 **${allInPlayerName} ALL-IN!** (Chỉ có thể Call hoặc Fold)\n`;
    const messageContent = `${header}👉 ${nextActor.name} Chọn — hành động: call/fold | ⏰ 30s ⚠️ **Auto FOLD nếu không click button!**
💸 Pot: ${game.pot.toLocaleString('vi-VN')} | Mức cược hiện tại: ${game.currentBet.toLocaleString('vi-VN')}
${boardDisplay}`;

    const existingMessageId = this.turnMessageIds.get(gameKey);
    if (existingMessageId) {
      try {
        await this.editChannelMessage(
          game.clanId,
          game.channelId,
          existingMessageId,
          messageContent,
          components,
        );
      } catch (_) {
        console.log('nextActorid', nextActor.id);
        const newId = await this.sendChannelMessage(
          game.clanId,
          game.channelId,
          messageContent,
          components,
          nextActor.id,
        );
        if (newId) this.turnMessageIds.set(gameKey, newId);
      }
    } else {
      const newId = await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        messageContent,
        components,
        nextActor.id,
      );
      if (newId) this.turnMessageIds.set(gameKey, newId);
    }

    const existingTurnTimeout = this.turnTimeouts.get(gameKey);
    if (existingTurnTimeout) clearTimeout(existingTurnTimeout);
    const turnTimeout = setTimeout(async () => {
      await this.handleTurnTimeout(game, nextActor.id);
    }, this.TURN_TIMEOUT);
    this.turnTimeouts.set(gameKey, turnTimeout);
  }

  // Xử lý khi hết timeout cho người chơi không đủ tiền
  private async handleInsufficientFundsTimeout(
    game: Game,
    playerId: string,
  ): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const currentGame = this.activeGames.get(gameKey);

    if (!currentGame) return;

    const player = currentGame.players.find((p) => p.id === playerId);
    if (!player || player.hasFolded) return;

    // Kiểm tra lại xem người chơi đã có đủ tiền chưa
    const callAmount = currentGame.currentBet - player.currentBet;
    const user = await this.userRepository.findOne({
      where: { user_id: playerId },
    });
    const userAmount = user?.amount || 0;

    if (userAmount < callAmount) {
      // Xóa insufficient funds message trước khi auto-fold

      await this.clearInsufficientFundsMessage(currentGame, playerId);

      player.hasFolded = true;
      this.removeFromToAct(currentGame, playerId);

      await this.sendChannelMessage(
        currentGame.clanId,
        currentGame.channelId,
        `⏰ **${player.name}** hết thời gian và không đủ tiền để call - tự động fold!`,
        undefined,
        playerId,
      );

      await this.saveGameToDatabase(currentGame);

      // Kiểm tra xem có cần chuyển lượt không
      await this.checkAndContinueGame(currentGame);
    }

    // Xóa timeout
    const timeoutKey = `insufficient_${gameKey}_${playerId}`;
    this.insufficientFundsTimeouts.delete(timeoutKey);
  }

  // Helper method để xóa insufficient funds message
  private async clearInsufficientFundsMessage(
    game: Game,
    playerId: string,
  ): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
    const messageKey = `insufficient_${gameKey}_${playerId}`;
    const messageId = this.insufficientFundsMessageIds.get(messageKey);
    if (messageId) {
      await this.deleteChannelMessage(game.clanId, game.channelId, messageId);
      this.insufficientFundsMessageIds.delete(messageKey);
    }
  }

  // Kiểm tra và tiếp tục game nếu cần
  private async checkAndContinueGame(game: Game): Promise<void> {
    const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);

    // Kiểm tra xem game đã được xử lý chưa để tránh duplicate processing
    if (!this.activeGames.has(gameKey)) {
      return;
    }

    const activePlayers = game.players.filter((p) => !p.hasFolded);

    if (activePlayers.length === 1) {
      const winner = activePlayers[0];
      // Cleanup turn and insufficient-funds messages before awarding
      await this.clearTurnTimeout(gameKey);
      const turnMessageId = this.turnMessageIds.get(gameKey);
      if (turnMessageId) {
        await this.deleteChannelMessage(
          game.clanId,
          game.channelId,
          turnMessageId,
        );
        this.turnMessageIds.delete(gameKey);
      }
      for (const p of game.players) {
        await this.clearInsufficientFundsMessage(game, p.id);
      }
      await this.awardPotAndRotate(game, [winner.id]);
      return;
    }

    const allMatched = activePlayers.every(
      (p) => p.currentBet === game.currentBet,
    );
    if (game.toActIds.length === 0 && allMatched) {
      // Kiểm tra xem có người chơi nào all-in không
      const allInPlayers = activePlayers.filter((p) => p.isAllIn);

      if (allInPlayers.length > 0) {
        // Có người all-in, hiển thị kết quả ngay lập tức
        await this.handleAllInShowdown(game);
        return;
      } else {
        // Kiểm tra nếu đang ở round river, chuyển sang showdown
        if (game.round === 'river') {
          game.round = 'showdown';
          await this.saveGameToDatabase(game);
          await this.handleShowdown(game);
          return;
        } else {
          // Không có all-in, chuyển round bình thường
          await this.advanceToNextRound(game);
          return;
        }
      }
    }

    // Chuyển lượt cho người tiếp theo
    if (game.currentPlayerIndex < game.players.length) {
      const nextIdx = this.findNextActorIndex(game, game.currentPlayerIndex);
      game.currentPlayerIndex = nextIdx;
      await this.saveGameToDatabase(game);
      await this.sendTurnActionButtons(game);
    }
  }

  private async endGameAfterRiver(game: Game): Promise<void> {
    try {
      // QUAN TRỌNG: Gọi showdown để xác định người thắng và thưởng tiền
      await this.handleShowdown(game);
    } catch (error) {
      console.error('Error ending game after river:', error);
    }
  }

  private async handleAllInShowdown(game: Game): Promise<void> {
    try {
      const gameKey = this.createGameKey(game.clanId, game.channelId, game.id);
      const turnMessageId = this.turnMessageIds.get(gameKey);
      if (turnMessageId) {
        await this.deleteChannelMessage(
          game.clanId,
          game.channelId,
          turnMessageId,
        );
        this.turnMessageIds.delete(gameKey);
      }

      // Mở hết các lá bài còn lại trước khi showdown
      await this.revealRemainingBoard(game);
      await this.saveGameToDatabase(game);

      // Lấy danh sách người chơi còn lại (chưa fold)
      const activePlayers = game.players.filter((p) => !p.hasFolded);

      if (activePlayers.length === 0) {
        await this.sendChannelMessage(
          game.clanId,
          game.channelId,
          `🎭 Showdown: không còn ai hợp lệ. Pot hoàn về nhà cái.`,
        );
        await this.resetForNextHand(game);
        return;
      }

      // Nếu chỉ còn 1 người chưa fold, người đó thắng
      if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        await this.awardPotAndRotate(game, [winner.id]);
        return;
      }

      // Nếu có 2 người trở lên, so sánh bài
      const ranked = activePlayers
        .map((p) => {
          const hand = [...p.hole, ...game.board];
          const rank = this.calculateHandRank(hand);
          return {
            player: p,
            rank,
            hand,
          };
        })
        .sort((a, b) => {
          if (a.rank.rank !== b.rank.rank) {
            return b.rank.rank - a.rank.rank; // Rank cao hơn lên trước
          }
          // Nếu cùng rank, so sánh kicker
          for (
            let i = 0;
            i < Math.min(a.rank.kickers.length, b.rank.kickers.length);
            i++
          ) {
            if (a.rank.kickers[i] !== b.rank.kickers[i]) {
              return b.rank.kickers[i] - a.rank.kickers[i];
            }
          }
          return 0;
        });

      const winner = ranked[0].player;
      const winners = [winner];

      let showdownMessage = `🎭 **Kết quả All-in:**\n`;

      // Hiển thị board nếu có
      if (game.board.length > 0) {
        showdownMessage += `Board: [ ${game.board.join(' ')} ]\n`;
      } else {
        showdownMessage += `Board: [ ___ ___ ___ ] (Chưa mở bài)\n`;
      }

      showdownMessage += `\n`;

      // Hiển thị kết quả của từng người chơi
      ranked.forEach((item, index) => {
        const { player, rank } = item;
        const rankName = this.getRankName(rank.rank);
        const cards = player.hole.map((card) => `[${card}]`).join(' ');
        const position = index + 1;

        showdownMessage += `${position}. **${player.name}**: ${cards} - *${rankName}*\n`;
      });

      await this.awardPotAndRotate(
        game,
        winners.map((w) => w.id),
        showdownMessage,
      );
    } catch (e) {
      console.error('All-in showdown error:', e);
      await this.sendChannelMessage(
        game.clanId,
        game.channelId,
        `❌ Lỗi showdown all-in: ${(e as Error).message}`,
      );
      await this.resetForNextHand(game);
    }
  }
}
