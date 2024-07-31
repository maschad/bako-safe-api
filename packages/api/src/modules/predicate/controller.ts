import { TransactionStatus } from 'bakosafe';
import { CoinQuantity, bn } from 'fuels';

import { Predicate } from '@src/models/Predicate';
import { Workspace } from '@src/models/Workspace';
import { EmailTemplateType, sendMail } from '@src/utils/EmailSender';
import { IconUtils } from '@src/utils/icons';

import { NotificationTitle, Transaction, TypeUser, User } from '@models/index';

import { error } from '@utils/error';
import {
  Responses,
  bindMethods,
  calculateBalanceUSD,
  subCoins,
  successful,
} from '@utils/index';

import { INotificationService } from '../notification/types';
import { IAsset, ITransactionService } from '../transaction/types';
import { IUserService } from '../user/types';
import { WorkspaceService } from '../workspace/services';
import {
  ICreatePredicateRequest,
  IDeletePredicateRequest,
  IFindByHashRequest,
  IFindByIdRequest,
  IFindByNameRequest,
  IListRequest,
  IPredicateService,
} from './types';
import { IPredicateVersionService } from '../predicateVersion/types';

export class PredicateController {
  private userService: IUserService;
  private predicateService: IPredicateService;
  private predicateVersionService: IPredicateVersionService;
  private transactionService: ITransactionService;
  private notificationService: INotificationService;

  constructor(
    userService: IUserService,
    predicateService: IPredicateService,
    predicateVersionService: IPredicateVersionService,
    transactionService: ITransactionService,
    notificationService: INotificationService,
  ) {
    this.userService = userService;
    this.predicateService = predicateService;
    this.predicateVersionService = predicateVersionService;
    this.transactionService = transactionService;
    this.notificationService = notificationService;
    bindMethods(this);
  }

  async create({ body: payload, user, workspace }: ICreatePredicateRequest) {
    const { versionCode } = payload;

    try {
      const members: User[] = [];

      for await (const member of payload.addresses) {
        let user = await this.userService.findByAddress(member);

        if (!user) {
          user = await this.userService.create({
            address: member,
            provider: payload.provider,
            avatar: IconUtils.user(),
            type: TypeUser.FUEL,
          });
        }

        members.push(user);
      }

      let version = null;

      if (versionCode) {
        version = await this.predicateVersionService.findByCode(versionCode);
      } else {
        version = await this.predicateVersionService.findCurrentVersion();
      }

      const newPredicate = await this.predicateService.create({
        ...payload,
        owner: user,
        members,
        workspace,
        version,
      });

      // include signer permission to vault on workspace
      await new WorkspaceService().includeSigner(
        members.map(member => member.id),
        newPredicate.id,
        workspace.id,
      );

      const {
        id,
        name,
        members: predicateMembers,
        workspace: wk_predicate,
      } = newPredicate;
      const summary = {
        vaultId: id,
        vaultName: name,
        workspaceId: wk_predicate.id,
      };
      const membersWithoutLoggedUser = predicateMembers.filter(
        member => member.id !== user.id,
      );

      for await (const member of membersWithoutLoggedUser) {
        await this.notificationService.create({
          title: NotificationTitle.NEW_VAULT_CREATED,
          user_id: member.id,
          summary,
        });

        if (member.notify) {
          await sendMail(EmailTemplateType.VAULT_CREATED, {
            to: member.email,
            data: { summary: { ...summary, name: member?.name ?? '' } },
          });
        }
      }

      const result = await this.predicateService
        .filter(undefined)
        .findById(newPredicate.id);

      return successful(result, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async delete({ params: { id } }: IDeletePredicateRequest) {
    try {
      const response = await this.predicateService.delete(id);

      return successful(response, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async findById({ params: { predicateId } }: IFindByIdRequest) {
    try {
      const predicate = await this.predicateService.findById(predicateId);
      // await this.predicateService.getMissingDeposits(predicate);

      return successful(predicate, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async findByAddress({ params: { address } }: IFindByHashRequest) {
    try {
      const response = await Predicate.findOne({
        where: { predicateAddress: address },
      });

      const predicate = await this.predicateService.findById(
        response.id,
        undefined,
      );

      return successful(predicate, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async findByName(req: IFindByNameRequest) {
    const { params, workspace } = req;
    const { name } = params;
    try {
      if (!name || name.length === 0) return successful(false, Responses.Ok);

      const response = await Predicate.createQueryBuilder('p')
        .leftJoin('p.workspace', 'w')
        .addSelect(['w.id', 'w.name'])
        .where('p.name = :name', { name })
        .andWhere('w.id = :workspace', { workspace: workspace.id })
        .getOne();

      return successful(!!response, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async hasReservedCoins({ params: { predicateId } }: IFindByIdRequest) {
    try {
      const predicate_txs = await Transaction.createQueryBuilder('t')
        .leftJoin('t.assets', 'a')
        .leftJoin('t.predicate', 'p')
        .addSelect(['t', 'a.assetId', 'a.amount', 'p.id'])
        // not moved to id, because we need add join to predicate
        .where('p.id = :predicateId', { predicateId })
        .andWhere('t.status IN (:...status)', {
          status: [
            TransactionStatus.AWAIT_REQUIREMENTS,
            TransactionStatus.PENDING_SENDER,
          ],
        })
        .getMany();

      const tx_reserved_balances = predicate_txs.reduce(
        (accumulator, transaction: Transaction) => {
          // TODO: Adjust logic to get assets from transaction resume
          transaction.assets.forEach((asset: IAsset) => {
            const assetId = asset.assetId;
            const amount = bn.parseUnits(asset.amount);
            const existingAsset = accumulator.find(
              item => item.assetId === assetId,
            );

            if (existingAsset) {
              existingAsset.amount = existingAsset.amount.add(amount);
            }
            accumulator.push({ assetId, amount });
          });
          return accumulator;
        },
        [] as CoinQuantity[],
      );

      const instance = await this.predicateService.instancePredicate(predicateId);
      const balances = await instance.getBalances();
      const assets =
        tx_reserved_balances.length > 0
          ? subCoins(balances, tx_reserved_balances)
          : balances;

      return successful(
        {
          reservedCoinsUSD: calculateBalanceUSD(tx_reserved_balances), // locked value on USDC
          totalBalanceUSD: calculateBalanceUSD(balances),
          currentBalanceUSD: calculateBalanceUSD(assets),
          currentBalance: assets,
          totalBalance: balances,
          reservedCoins: tx_reserved_balances, // locked coins
        },
        Responses.Ok,
      );
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async list(req: IListRequest) {
    const {
      provider,
      address: predicateAddress,
      owner,
      orderBy,
      sort,
      page,
      perPage,
      q,
    } = req.query;
    const { workspace, user } = req;

    try {
      const singleWorkspace = await new WorkspaceService()
        .filter({
          user: user.id,
          single: true,
        })
        .list()
        .then((response: Workspace[]) => response[0]);

      const hasSingle = singleWorkspace.id === workspace.id;

      const _wk = hasSingle
        ? await new WorkspaceService()
            .filter({
              user: user.id,
            })
            .list()
            .then((response: Workspace[]) => response.map(wk => wk.id))
        : [workspace.id];

      const response = await this.predicateService
        .filter({
          address: predicateAddress,
          provider,
          owner,
          q,
          workspace: _wk,
          signer: hasSingle ? user.address : undefined,
        })
        .ordination({ orderBy, sort })
        .paginate({ page, perPage })
        .list();

      return successful(response, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }
}
