import { Router } from 'express';

import { authMiddleware } from '@middlewares/index';

import { handleResponse } from '@utils/index';

import { UserController } from './controller';
import { UserService } from './service';
import { PayloadCreateUserSchema, PayloadUpdateUserSchema } from './validation';

const router = Router();
const userService = new UserService();
const userController = new UserController(userService);

router.post('/', PayloadCreateUserSchema, handleResponse(userController.create));

router.get('/nickaname/:nickname', handleResponse(userController.validateName));
router.get('/me', authMiddleware, handleResponse(userController.me));
router.get('/', authMiddleware, handleResponse(userController.find));
router.get('/:id', authMiddleware, handleResponse(userController.findOne));
router.put(
  '/:id',
  authMiddleware,
  PayloadUpdateUserSchema,
  handleResponse(userController.update),
);

// router.get('/:nickname', handleResponse(userController.validateName));
router.delete('/:id', authMiddleware, handleResponse(userController.delete));

export default router;
