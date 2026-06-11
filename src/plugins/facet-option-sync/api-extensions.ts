import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    extend type Mutation {
        """
        Ensures that for each facet marked "Use for variant options" whose values are
        assigned to the given product, a matching ProductOptionGroup exists on the
        product with a ProductOption per assigned facet value. Additive only:
        existing groups/options are never renamed or deleted. Idempotent.
        """
        syncProductOptionsFromFacets(productId: ID!): Product!
    }
`;
