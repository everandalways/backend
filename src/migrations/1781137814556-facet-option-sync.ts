import {MigrationInterface, QueryRunner} from "typeorm";

export class FacetOptionSync1781137814556 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "facet" ADD "customFieldsUsedforvariantoptions" boolean NOT NULL DEFAULT false`, undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`ALTER TABLE "facet" DROP COLUMN "customFieldsUsedforvariantoptions"`, undefined);
   }

}
