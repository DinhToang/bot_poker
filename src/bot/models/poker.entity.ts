import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('poker_games')
export class PokerGame {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  clanId: string;

  @Column()
  channelId: string;

  @Column()
  creatorId: string;

  @Column('json')
  gameState: any;

  @Column({ default: false })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
