import { TransactionStatus } from 'bsafe';
import { addMinutes } from 'date-fns';

import { DApp, Predicate, RecoverCodeType, Transaction, User } from '@src/models';
import { SocketClient } from '@src/socket/client';

import { error } from '@utils/error';
import { Responses, bindMethods, successful } from '@utils/index';

import { PredicateService } from '../predicate/services';
import { RecoverCodeService } from '../recoverCode/services';
import { TransactionService } from '../transaction/services';
import { DAppsService } from './service';
import {
  ICreateRecoverCodeRequest,
  ICreateRequest,
  IDAppsService,
  IDappRequest,
} from './types';

export class DappController {
  private _dappService: IDAppsService;

  constructor(dappService: IDAppsService) {
    this._dappService = dappService;
    bindMethods(this);
  }

  async connect({ body }: ICreateRequest) {
    try {
      const { vaultId, sessionId, name, origin, userAddress } = body;
      const predicate = await new PredicateService().findById(vaultId);
      let dapp = await new DAppsService().findBySessionID(sessionId, origin);
      const user = await User.findOne({ where: { address: userAddress } });
      if (!dapp) {
        dapp = await new DAppsService().create({
          sessionId,
          name: name ?? ``,
          origin,
          vaults: [predicate],
          currentVault: predicate,
          user,
        });
      }

      const isIncludedVault = dapp.vaults.find(v => v.id === vaultId);

      if (!isIncludedVault) {
        dapp.vaults = [...dapp.vaults, predicate];
      }
      dapp.currentVault = predicate;
      await dapp.save();

      console.log('[FINISH_SEND_MESSAGE]');

      const socket = new SocketClient(sessionId, origin);
      socket.sendMessage({
        room: sessionId,
        to: '[CONNECTOR]',
        type: '[AUTH_CONFIRMED]',
        data: {
          connected: true,
        },
      });

      return successful(true, Responses.Created);
    } catch (e) {
      console.log(e);
      return error(e.error, e.statusCode);
    }
  }

  async currentAccount({ params, headers }: IDappRequest) {
    try {
      const a = await this._dappService.findBySessionID(
        params.sessionId,
        headers.origin || headers.Origin,
      );
      return successful(a.currentVault.predicateAddress, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async disconnect({ params, headers }: IDappRequest) {
    try {
      const { sessionId } = params;
      const origin = headers.origin || headers.Origin;
      await new DAppsService().delete(sessionId, origin);
      return successful(null, Responses.NoContent);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async createConnectorCode({ body, headers, params }: ICreateRecoverCodeRequest) {
    try {
      const { sessionId, vaultAddress, txId } = params;
      const { origin } = headers;

      const pendingTransactions = await new TransactionService()
        .filter({
          status: [TransactionStatus.AWAIT_REQUIREMENTS],
          predicateAddress: vaultAddress,
        })
        .list()
        .then((data: Transaction[]) => {
          return data.length > 0;
        });

      const { predicateAddress, id, name } = await new PredicateService()
        .filter({
          address: vaultAddress,
        })
        .list()
        .then((data: Predicate[]) => data[0]);

      const dapp = await new DAppsService().findBySessionID(sessionId, origin);

      const code = await new RecoverCodeService().create({
        owner: dapp.user,
        type: RecoverCodeType.TX_CONNECTOR,
        origin,
        validAt: addMinutes(new Date(), 2), //todo: change this number to dynamic
        metadata: {
          uses: 0, // todo: increment this number on each use
          txId,
          vault: {
            id,
            address: predicateAddress,
            name: name,
          },
        },
      });

      // const socket = new SocketClient(sessionId, origin);
      // socket.sendMessage({
      //   room: sessionId,
      //   to: '[UI]',
      //   type: '[TX_PENDING]',
      //   data: {
      //     ...code.metadata,
      //     code: code.code,
      //     validAt: code.validAt,
      //   },
      // });

      return successful(
        {
          code: code.code,
          validAt: code.validAt,
          tx_blocked: pendingTransactions,
          metadata: code.metadata,
        },
        Responses.Created,
      );
    } catch (e) {
      console.log(e);
      return error(e.error, e.statusCode);
    }
  }

  async current({ params }: IDappRequest) {
    try {
      const currentVaultId = await this._dappService.findCurrent(params.sessionId);
      return successful(currentVaultId, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async currentNetwork({ params, headers }: IDappRequest) {
    try {
      const a = await this._dappService.findBySessionID(
        params.sessionId,
        headers.origin || headers.Origin,
      );
      return successful(a.currentVault.provider, Responses.Ok);
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async accounts({ params, headers }: IDappRequest) {
    try {
      return successful(
        await this._dappService
          .findBySessionID(params.sessionId, headers.origin || headers.Origin)
          .then((data: DApp) => data.vaults.map(vault => vault.predicateAddress)),
        Responses.Ok,
      );
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }

  async state({ params, headers }: IDappRequest) {
    try {
      return successful(
        await this._dappService
          .findBySessionID(params.sessionId, headers.origin || headers.Origin)
          .then((data: DApp) => {
            return !!data; // todo: verify return more info about the dapp and validate on connector
          }),
        Responses.Ok,
      );
    } catch (e) {
      return error(e.error, e.statusCode);
    }
  }
}
