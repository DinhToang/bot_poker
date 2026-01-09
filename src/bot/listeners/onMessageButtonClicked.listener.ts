import { OnEvent } from '@nestjs/event-emitter';
import { Events } from 'mezon-sdk';
import { Injectable } from '@nestjs/common';
import { RoleService } from '../commands/selfAssignableRoles/role.service';
import { PokerService } from '../commands/poker/poker.service';

@Injectable()
export class ListenerMessageButtonClicked {
  constructor(
    private roleService: RoleService,
    private pokerService: PokerService,
  ) {}

  @OnEvent(Events.MessageButtonClicked)
  async handleButtonForm(data) {
    try {
      const args = data.button_id.split('_');
      const buttonConfirmType = args[0];

      switch (buttonConfirmType) {
        case 'role':
          this.handleSelectRole(data);
          break;
        case 'poker':
          this.handlePoker(data);
          break;
        default:
          break;
      }
    } catch (error) {
      // Error handling
    }
  }

  async handleSelectRole(data) {
    try {
      await this.roleService.handleSelectRole(data);
    } catch (error) {}
  }

  async handlePoker(data) {
    try {
      const args = data.button_id.split('_');
      const action = args[1];

      switch (action) {
        case 'join':
          await this.handlePokerJoin(data);
          break;
        case 'decline':
          await this.handlePokerDecline(data);
          break;
        case 'call':
          await this.handlePokerCall(data);
          break;
        case 'raise':
          await this.handlePokerRaise(data);
          break;
        case 'raise1':
          await this.handlePokerRaiseQuick(data, 1);
          break;
        case 'raise2':
          await this.handlePokerRaiseQuick(data, 2);
          break;
        case 'raisepot':
          await this.handlePokerRaiseQuick(data, 'pot' as any);
          break;
        case 'check':
          await this.handlePokerCheck(data);
          break;
        case 'allin':
          await this.handlePokerAllIn(data);
          break;
        case 'fold':
          await this.handlePokerFold(data);
          break;
        case 'continue':
          await this.handlePokerContinue(data);
          break;

        default:
          break;
      }
    } catch (error) {
      // Error handling
    }
  }

  async handlePokerJoin(data) {
    try {
      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }
      const invite = this.pokerService.getGameInvite(gameId);
      if (
        !invite ||
        !invite.mentionedUsers.some((u) => u.idUser === data.user_id)
      ) {
        return;
      }

      const result = await this.pokerService.handleButtonClick(
        data.user_id,
        'poker_join',
        gameId,
        data.channel_id,
        data.message_id,
        data.clan_id,
      );

      if (result.success) {
        if (result.gameStarted) {
          await this.notifyGameStarted(data, gameId);
        } else if (result.shouldUpdate) {
          await this.updateInviteMessage(data, gameId);
        }
      }
    } catch (error) {
      // Error handling
    }
  }

  // Button: Call
  async handlePokerCall(data) {
    try {
      // Extract clanId và channelId từ button_id nếu data.clan_id undefined
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        // Format: poker_call_${gameId}_${clanId}_${channelId}
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      const result = await this.pokerService.makeCall(
        clanId,
        channelId,
        gameId,
        data.message_id,
        userId,
      );
    } catch (error) {
      // Error handling
    }
  }

  // Button: Check
  async handlePokerCheck(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      const result = await this.pokerService.makeCheck(
        clanId,
        channelId,
        gameId,
        data.message_id,
        userId,
      );

      if (result.success) {
      }
    } catch (error) {
      // Error handling
    }
  }

  // Button: Raise
  async handlePokerRaise(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      const result = await this.pokerService.makeRaiseByBetAmount(
        clanId,
        channelId,
        gameId,
        data.message_id,
        userId,
      );

      if (result.success) {
      }
    } catch (error) {
      // Error handling
    }
  }

  // Quick raise: +1x bet, +2x bet, +pot
  async handlePokerRaiseQuick(data, type: 1 | 2 | 'pot') {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;
      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;
      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      if (type === 1) {
        await this.pokerService.makeRaiseByBetAmount(
          clanId,
          channelId,
          gameId,
          data.message_id,
          userId,
        );
        return;
      }

      if (type === 2) {
        await this.pokerService.makeRaiseByMultiplier(
          clanId,
          channelId,
          gameId,
          data.message_id,
          userId,
          2,
        );
        return;
      }

      // pot
      await this.pokerService.makeRaiseByPot(
        clanId,
        channelId,
        gameId,
        data.message_id,
        userId,
      );
    } catch (error) {
      // Error handling
    }
  }

  // Đã bỏ hành động Tùy chỉnh theo yêu cầu

  // Button: All-in
  async handlePokerAllIn(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      await this.pokerService.makeAllIn(
        clanId,
        channelId,
        gameId,
        data.message_id,
        userId,
      );
    } catch (error) {
      // Error handling
    }
  }

  async handlePokerFold(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      const result = await this.pokerService.makeFold(
        clanId,
        channelId,
        gameId,
        userId,
        data.message_id,
      );
    } catch (error) {
      // Error handling
    }
  }

  // Trích xuất gameId từ data
  private extractGameIdFromData(data): string | null {
    try {
      if (data.button_id) {
        const parts = data.button_id.split('_');

        if (parts.length >= 5 && parts[0] === 'poker') {
          // Format chuẩn: poker_<action>_<gameId_with_underscores>_<clanId>_<channelId>
          // Khôi phục gameId bằng cách nối các phần từ index 2 đến phần tử áp chót thứ 2
          const gameIdParts = parts.slice(2, parts.length - 2);
          const gameId = gameIdParts.join('_');
          return gameId;
        }
      }

      // Fallback: tìm trong message content nếu button ID không có format mong đợi
      if (data.message && data.message.content) {
        const gameIdMatch = data.message.content.match(
          /Game ID: ([a-zA-Z0-9_]+)/,
        );
        if (gameIdMatch) {
          return gameIdMatch[1];
        }
      }

      // Fallback: tìm trong embeds
      if (
        data.message &&
        data.message.embeds &&
        data.message.embeds.length > 0
      ) {
        const embed = data.message.embeds[0];
        if (embed.description) {
          const gameIdMatch = embed.description.match(/poker_[a-zA-Z0-9_]+/);
          if (gameIdMatch) {
            return gameIdMatch[0];
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // Gửi response lỗi

  // Cập nhật invite message với trạng thái mới
  private async updateInviteMessage(data, gameId: string) {
    try {
      const responses = this.pokerService.getInviteResponses(gameId);
      const invite = this.pokerService.getGameInvite(gameId);

      if (!invite) return;

      // Tạo updated message content
      let updatedContent = `🎰 **POKER GAME INVITATION** 🎰\n\n`;
      updatedContent += `📊 **Trạng thái:**\n`;
      updatedContent += `✅ Đã tham gia: ${responses.joined.length}\n`;
      updatedContent += `❌ Từ chối: ${responses.declined.length}\n`;
      updatedContent += `⏳ Chưa phản hồi: ${responses.pending.length}\n\n`;

      const timeLeft = Math.max(
        0,
        Math.floor((invite.expiresAt.getTime() - Date.now()) / 1000),
      );
      updatedContent += `⏰ **Thời gian còn lại: ${timeLeft}s**\n`;

      if (responses.pending.length === 0) {
        updatedContent += `\n🎯 **Tất cả đã phản hồi! Game sẽ bắt đầu sớm...**`;
      }

      // TODO: Update actual message
    } catch (error) {
      // Error handling
    }
  }

  // Thông báo game đã bắt đầu
  private async notifyGameStarted(data, gameId: string) {
    try {
      // TODO: Gửi message thông báo game bắt đầu

      // Có thể gửi message mới hoặc update message hiện tại
      const startedMessage =
        `🎰 **GAME BẮT ĐẦU!** 🎰\n\n` +
        `🎮 Game ID: ${gameId}\n` +
        `🎯 Bài đã được phát cho tất cả người chơi!\n` +
        `💡 Sử dụng lệnh \`/poker status\` để xem trạng thái game`;
    } catch (error) {
      // Error handling
    }
  }

  // Button: Continue game
  async handlePokerContinue(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      await this.pokerService.continueGame(clanId, channelId, gameId, userId);
    } catch (error) {
      // Error handling
    }
  }

  // Button: Decline game
  async handlePokerDecline(data) {
    try {
      let clanId = data.clan_id;
      let channelId = data.channel_id;

      if (!clanId || !channelId) {
        const parts = data.button_id.split('_');
        if (parts.length >= 5) {
          clanId = parts[parts.length - 2];
          channelId = parts[parts.length - 1];
        }
      }

      const userId = data.user_id;

      if (!clanId || !channelId) {
        return;
      }

      const gameId = this.extractGameIdFromData(data);
      if (!gameId) {
        return;
      }

      await this.pokerService.declineGame(clanId, channelId, gameId, userId);
    } catch (error) {
      // Error handling
    }
  }
}
